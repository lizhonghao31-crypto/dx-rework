import { describe, expect, it } from "vitest";

import {
  AuthService,
  type AuthStore,
  type AuthUser,
  type QrChallenge,
  type SessionRecord,
} from "../../apps/api/src/auth/service.js";
import type {
  DingTalkIdentity,
  DingTalkProvider,
  OrganizationMember,
} from "../../apps/api/src/auth/provider.js";

class RaceStore implements AuthStore {
  readonly sessions: SessionRecord[] = [];
  private readonly codes = new Set<string>();

  async cleanupExpiredAuthArtifacts() {}
  async consumeCode(codeHash: string) {
    if (this.codes.has(codeHash)) return false;
    this.codes.add(codeHash);
    return true;
  }
  async consumeQrState() { return false; }
  async createQrState(_challenge: QrChallenge) {}
  async upsertIdentity(member: OrganizationMember): Promise<AuthUser> {
    return { id: "worker-internal", displayName: member.displayName, businessRoles: ["worker"], capabilities: ["work:report"] };
  }
  async createSession(session: SessionRecord) { this.sessions.push(session); }
  async findSession() { return null; }
  async deactivateIdentity() {}
  async revokeSession(tokenHash: string, now: Date) {
    const index = this.sessions.findIndex(session => session.tokenHash === tokenHash);
    if (index >= 0) this.sessions[index] = { ...this.sessions[index]!, revokedAt: now };
  }
}

class RacingAcceptanceProvider implements DingTalkProvider {
  private controlActive = true;
  private releaseMember!: () => void;
  readonly memberLookupStarted = new Promise<void>(resolve => { this.memberLookupStartedResolve = resolve; });
  private memberLookupStartedResolve!: () => void;
  private readonly memberRelease = new Promise<void>(resolve => { this.releaseMember = resolve; });

  buildQrAuthorizationUrl() { return "https://acceptance.invalid"; }
  async exchangeQrCode(): Promise<DingTalkIdentity> { throw new Error("not used"); }
  async exchangeMobileCode(): Promise<DingTalkIdentity> {
    return { userId: "uat-worker-a", unionId: "uat-union-worker-a", corpId: "corp-acceptance" };
  }
  async getOrganizationMember(): Promise<OrganizationMember> {
    this.memberLookupStartedResolve();
    await this.memberRelease;
    return {
      corpId: "corp-acceptance", userId: "uat-worker-a", unionId: "uat-union-worker-a",
      active: true, employed: true, displayName: "[UAT] 工人甲",
    };
  }

  async beginAcceptanceControl() { this.controlActive = true; return "control"; }
  assertAcceptanceControl() { if (!this.controlActive) throw new Error("control ended"); }
  async listAcceptanceIdentities() { return []; }
  async issueAcceptanceLoginCode() {
    this.assertAcceptanceControl();
    return "race-login-code";
  }
  async endAcceptanceControl() { this.controlActive = false; }
  finishMemberLookup() { this.releaseMember(); }
}

describe("acceptance switch/end race", () => {
  it("revokes a session created by an in-flight switch when control ends before the switch returns", async () => {
    const store = new RaceStore();
    const provider = new RacingAcceptanceProvider();
    const auth = new AuthService(
      provider,
      store,
      "corp-acceptance",
      60_000,
      "acceptance-race-session-secret-longer-than-32-characters",
    );

    const switching = auth.switchAcceptanceIdentity("control", "worker-a");
    await provider.memberLookupStarted;
    await provider.endAcceptanceControl();
    provider.finishMemberLookup();

    await expect(switching).rejects.toMatchObject({ code: "ACCEPTANCE_CONTROL_REQUIRED" });
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]?.revokedAt).toBeInstanceOf(Date);
  });
});
