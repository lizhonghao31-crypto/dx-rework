import { describe, expect, it, vi } from "vitest";

import {
  AcceptanceDingTalkProvider,
  mintAcceptanceLoginCode,
  type AcceptanceIdentityDatabase,
} from "../../apps/api/src/auth/acceptance-provider.js";

const secret = "acceptance-lab-secret-with-more-than-32-characters";
const now = Date.parse("2026-09-08T06:00:00Z");

const row = {
  provider_user_id: "uat-finance-director",
  union_id: "uat-union-finance-director",
  display_name: "[UAT] 财务总监",
  active: true,
  employed: true,
  department_names: ["验收中心"],
};

const database = () => ({
  query: vi.fn(async (text: string, params?: unknown[]) => {
    if (text.includes("employee_directory_profiles")) return { rows: [row] };
    return { rows: params?.[1] === row.provider_user_id ? [row] : [] };
  }),
}) as unknown as AcceptanceIdentityDatabase;

describe("AcceptanceDingTalkProvider", () => {
  it("mints a short-lived signed code and resolves only the matching synthetic identity", async () => {
    const provider = new AcceptanceDingTalkProvider(database(), "corp-uat", secret, () => now);
    const code = mintAcceptanceLoginCode("finance-director", secret, now);

    await expect(provider.exchangeMobileCode(code)).resolves.toEqual({
      userId: "uat-finance-director",
      unionId: "uat-union-finance-director",
      corpId: "corp-uat",
    });
    await expect(provider.getOrganizationMember({
      userId: "uat-finance-director",
      unionId: "uat-union-finance-director",
      corpId: "corp-uat",
    }, "corp-uat")).resolves.toMatchObject({
      displayName: "[UAT] 财务总监",
      active: true,
      employed: true,
    });
  });

  it("rejects expired or tampered login codes", async () => {
    const provider = new AcceptanceDingTalkProvider(database(), "corp-uat", secret, () => now + 6 * 60_000);
    const expired = mintAcceptanceLoginCode("finance-director", secret, now, 5 * 60_000);
    await expect(provider.exchangeMobileCode(expired)).rejects.toThrow(/expired|invalid/i);

    const current = mintAcceptanceLoginCode("finance-director", secret, now);
    const tampered = `${current.slice(0, -1)}${current.endsWith("0") ? "1" : "0"}`;
    await expect(new AcceptanceDingTalkProvider(database(), "corp-uat", secret, () => now).exchangeMobileCode(tampered))
      .rejects.toThrow(/signature|invalid/i);
  });

  it("never accepts a real or non-UAT identity through the acceptance provider", async () => {
    const provider = new AcceptanceDingTalkProvider(database(), "corp-uat", secret, () => now);
    await expect(provider.getOrganizationMember({
      userId: "real-finance-director",
      unionId: "real-union-finance-director",
      corpId: "corp-uat",
    }, "corp-uat")).resolves.toBeNull();
  });

  it("lists only the synthetic acceptance directory exposed by the isolated database", async () => {
    const provider = new AcceptanceDingTalkProvider(database(), "corp-uat", secret, () => now);
    await expect(provider.listOrganizationMembers("corp-uat")).resolves.toEqual([{
      corpId: "corp-uat",
      userId: "uat-finance-director",
      unionId: "uat-union-finance-director",
      displayName: "[UAT] 财务总监",
      active: true,
      employed: true,
      departmentNames: ["验收中心"],
    }]);
  });
});
