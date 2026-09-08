import { describe, expect, it, vi } from "vitest";

import {
  AcceptanceControlAuthority,
  mintAcceptanceControlCode,
} from "../../apps/api/src/auth/acceptance-control.js";

const secret = "acceptance-control-secret-with-more-than-32-characters";
const now = 1_788_860_000_000;

const cleanRows = [{
  user_id: "00000000-0000-4000-8000-000000000001",
  provider_user_id: "uat-worker-a",
  display_name: "[UAT] 工人甲",
  active: true,
  employed: true,
  role_codes: ["worker"],
  capabilities: ["tools:user", "work:report"],
}];

describe("acceptance control authority", () => {
  it("uses a one-time control code and an independent opaque control session", () => {
    const database = { query: vi.fn() };
    const authority = new AcceptanceControlAuthority(database as never, secret, () => now);
    const code = mintAcceptanceControlCode(secret, now);
    const token = authority.begin(code);
    expect(token).not.toContain("worker");
    expect(() => authority.assertControl(token)).not.toThrow();
    expect(() => authority.begin(code)).toThrow(/already been used/i);
  });

  it("refuses missing control authorization before reading identities", async () => {
    const query = vi.fn();
    const authority = new AcceptanceControlAuthority({ query } as never, secret, () => now);
    await expect(authority.listIdentities(undefined)).rejects.toThrow(/control session/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("lists only synthetic acceptance identities and issues a role login code under control", async () => {
    const query = vi.fn(async () => ({ rows: cleanRows }));
    const authority = new AcceptanceControlAuthority({ query } as never, secret, () => now);
    const token = authority.begin(mintAcceptanceControlCode(secret, now));
    const identities = await authority.listIdentities(token);
    expect(identities).toEqual([expect.objectContaining({ alias: "worker-a", roleCodes: ["worker"] })]);
    const loginCode = await authority.issueLoginCode(token, "worker-a");
    const payload = JSON.parse(Buffer.from(loginCode.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload.alias).toBe("worker-a");
  });

  it("rejects an alias that is not an active seeded identity", async () => {
    const query = vi.fn(async () => ({ rows: cleanRows }));
    const authority = new AcceptanceControlAuthority({ query } as never, secret, () => now);
    const token = authority.begin(mintAcceptanceControlCode(secret, now));
    await expect(authority.issueLoginCode(token, "system-admin")).rejects.toThrow(/unavailable/i);
  });

  it("ending control invalidates the controller without relying on the business session", () => {
    const authority = new AcceptanceControlAuthority({ query: vi.fn() } as never, secret, () => now);
    const token = authority.begin(mintAcceptanceControlCode(secret, now));
    authority.end(token);
    expect(() => authority.assertControl(token)).toThrow(/control session/i);
  });
});
