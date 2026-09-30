import { describe, expect, it, vi } from "vitest";

import {
  AcceptanceControlAuthority,
  mintAcceptanceControlCode,
} from "../../apps/api/src/auth/acceptance-control.js";

const secret = "acceptance-control-secret-with-more-than-32-characters";
const now = 1_788_860_000_000;
const corpId = "corp-acceptance";

const cleanRows = [{
  user_id: "00000000-0000-4000-8000-000000000001",
  provider_user_id: "uat-worker-a",
  display_name: "[UAT] 工人甲",
  active: true,
  employed: true,
  role_codes: ["worker"],
  capabilities: ["tools:user", "work:report"],
}];

const fakeDatabase = (identityRows = cleanRows) => {
  const consumed = new Set<string>();
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (sql.startsWith("INSERT INTO auth_consumed_codes")) {
      const key = String(params?.[0] ?? "");
      if (consumed.has(key)) return { rows: [], rowCount: 0 };
      consumed.add(key);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE auth_sessions")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM identity_mappings")) return { rows: identityRows, rowCount: identityRows.length };
    return { rows: [], rowCount: 0 };
  });
  return { query, consumed };
};

describe("acceptance control authority", () => {
  it("uses a one-time control code and an independent opaque control session", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const code = mintAcceptanceControlCode(secret, now);
    const token = await authority.begin(code);
    expect(token).not.toContain("worker");
    expect(() => authority.assertControl(token)).not.toThrow();
    await expect(authority.begin(code)).rejects.toThrow(/already been used/i);
  });

  it("persists control-code consumption across authority instances", async () => {
    const database = fakeDatabase();
    const code = mintAcceptanceControlCode(secret, now);
    const first = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const second = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    await first.begin(code);
    await expect(second.begin(code)).rejects.toThrow(/already been used/i);
  });

  it("refuses missing control authorization before reading identities", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    await expect(authority.listIdentities(undefined)).rejects.toThrow(/control session/i);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("lists only synthetic acceptance identities and revokes earlier sessions before issuing a role login code", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    const identities = await authority.listIdentities(token);
    expect(identities).toEqual([expect.objectContaining({ alias: "worker-a", roleCodes: ["worker"] })]);
    const loginCode = await authority.issueLoginCode(token, "worker-a");
    const payload = JSON.parse(Buffer.from(loginCode.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload.alias).toBe("worker-a");
    expect(database.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE auth_sessions"))).toBe(true);
  });

  it("keeps retired synthetic identities out of the control directory and makes them unswitchable", async () => {
    const database = fakeDatabase([
      ...cleanRows,
      {
        user_id: "00000000-0000-4000-8000-000000000002",
        provider_user_id: "uat-sample-approver",
        display_name: "[UAT] 旧样衣审批人",
        active: true,
        employed: true,
        role_codes: ["sample_approver"],
        capabilities: ["sample:view_basic"],
      },
    ]);
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    const identities = await authority.listIdentities(token);
    expect(identities.map((identity) => identity.alias)).toEqual(["worker-a"]);
    await expect(authority.issueLoginCode(token, "sample-approver")).rejects.toThrow(/unavailable/i);
  });

  it("rejects an alias that is not an active seeded identity", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    await expect(authority.issueLoginCode(token, "system-admin")).rejects.toThrow(/unavailable/i);
  });

  it("ending control revokes every UAT business session and invalidates the controller", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    await authority.end(token);
    expect(() => authority.assertControl(token)).toThrow(/control session/i);
    expect(database.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE auth_sessions"))).toBe(true);
  });
});
