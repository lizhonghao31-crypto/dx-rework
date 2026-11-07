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
  const controllers = new Map<string, { authority: unknown; corp: unknown; expiresAt: Date; revoked: boolean }>();
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (sql.startsWith("DELETE FROM acceptance_control_sessions")) return { rows: [], rowCount: 0 };
    if (sql.includes("WITH consumed AS")) {
      const key = String(params?.[0] ?? "");
      if (consumed.has(key)) return { rows: [], rowCount: 0 };
      consumed.add(key);
      controllers.set(String(params?.[2]), { corp: params?.[3], authority: params?.[4], expiresAt: params?.[6] as Date, revoked: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT token_hash FROM acceptance_control_sessions")) {
      const controller = controllers.get(String(params?.[0]));
      const valid = controller && controller.corp === params?.[1] && controller.authority === params?.[2]
        && !controller.revoked && controller.expiresAt > (params?.[3] as Date);
      return { rows: valid ? [{ token_hash: params?.[0] }] : [], rowCount: valid ? 1 : 0 };
    }
    if (sql.includes("WITH ended AS")) {
      const controller = controllers.get(String(params?.[0]));
      if (controller) controller.revoked = true;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM identity_mappings")) return { rows: identityRows, rowCount: identityRows.length };
    throw new Error("Unexpected SQL in isolated control test");
  });
  return { query, consumed, controllers };
};

describe("acceptance control authority", () => {
  it("uses a one-time control code and an independent opaque control session", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const code = mintAcceptanceControlCode(secret, now);
    const token = await authority.begin(code);
    expect(token).not.toContain("worker");
    await expect(authority.assertControl(token)).resolves.toBeUndefined();
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

  it("lists only synthetic acceptance identities without revoking other browser sessions when issuing a role login code", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    const identities = await authority.listIdentities(token);
    expect(identities).toEqual([expect.objectContaining({ alias: "worker-a", roleCodes: ["worker"] })]);
    const loginCode = await authority.issueLoginCode(token, "worker-a");
    const payload = JSON.parse(Buffer.from(loginCode.split(".")[0]!, "base64url").toString("utf8"));
    expect(payload.alias).toBe("worker-a");
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE auth_sessions"))).toBe(false);
    const otherCode = await authority.issueLoginCode(token, "worker-a");
    expect(otherCode).not.toBe(loginCode);
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

  it("ending control invalidates the persistent controller and only its linked business token", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    await authority.end(token);
    await expect(authority.assertControl(token)).rejects.toThrow(/control session/i);
    expect(database.query.mock.calls.some(([sql]) => String(sql).includes("session.token_hash=ended.business_token_hash"))).toBe(true);
  });

  it("restores a 30-day controller in a new process model without storing its raw token", async () => {
    const database = fakeDatabase();
    let clock = now;
    const first = new AcceptanceControlAuthority(database as never, corpId, secret, () => clock, 2592000);
    const token = await first.begin(mintAcceptanceControlCode(secret, now));
    expect([...database.controllers.keys()]).not.toContain(token);
    expect([...database.controllers.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    clock += 29 * 86400000;
    const restarted = new AcceptanceControlAuthority(database as never, corpId, secret, () => clock, 2592000);
    await expect(restarted.assertControl(token)).resolves.toBeUndefined();
    clock = now + 30 * 86400000;
    await expect(restarted.assertControl(token)).rejects.toThrow(/control session/i);
  });

  it("rejects another corporation or a rotated dedicated secret after a restart", async () => {
    const database = fakeDatabase();
    const authority = new AcceptanceControlAuthority(database as never, corpId, secret, () => now);
    const token = await authority.begin(mintAcceptanceControlCode(secret, now));
    await expect(new AcceptanceControlAuthority(database as never, "other-corp", secret, () => now).assertControl(token)).rejects.toThrow(/control session/i);
    await expect(new AcceptanceControlAuthority(database as never, corpId, secret + "-rotated", () => now).assertControl(token)).rejects.toThrow(/control session/i);
  });
});
