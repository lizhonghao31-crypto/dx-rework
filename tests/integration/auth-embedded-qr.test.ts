import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { loadConfig } from "@dx-rework/config";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import type { DingTalkIdentity, DingTalkProvider, OrganizationMember } from "../../apps/api/src/auth/provider.js";
import {
  AuthService,
  stableEqual,
  type AuthStore,
  type AuthUser,
  type QrChallenge,
  type SessionRecord,
} from "../../apps/api/src/auth/service.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp-a",
  DINGTALK_H5_APP_KEY: "mobile-client",
  DINGTALK_H5_APP_SECRET: "mobile-secret",
  DINGTALK_WEB_CLIENT_ID: "web-client",
  DINGTALK_WEB_CLIENT_SECRET: "web-secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/rework/auth/qr/relay",
  APP_BASE_PATH: "/rework/",
  SESSION_SECRET: "a-test-secret-that-is-longer-than-32-characters",
});

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

class MemoryStore implements AuthStore {
  readonly codes = new Set<string>();
  readonly states = new Map<string, QrChallenge>();
  readonly sessions: SessionRecord[] = [];

  async cleanupExpiredAuthArtifacts(): Promise<void> {}
  async consumeCode(codeHash: string): Promise<boolean> {
    if (this.codes.has(codeHash)) return false;
    this.codes.add(codeHash);
    return true;
  }
  async createQrState(challenge: QrChallenge): Promise<void> {
    this.states.set(challenge.stateHash, challenge);
  }
  async consumeQrState(stateHash: string, bindingHash: string, now: Date): Promise<boolean> {
    const challenge = this.states.get(stateHash);
    if (!challenge || challenge.usedAt || challenge.expiresAt <= now || !stableEqual(challenge.bindingHash, bindingHash)) return false;
    this.states.set(stateHash, { ...challenge, usedAt: now });
    return true;
  }
  async upsertIdentity(member: OrganizationMember): Promise<AuthUser> {
    return {
      id: `user-${member.userId}`,
      displayName: member.displayName,
      businessRoles: ["quality_control"],
      capabilities: ["rework:read"],
    };
  }
  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.push(session);
  }
  async findSession(): Promise<null> { return null; }
  async deactivateIdentity(): Promise<void> {}
  async revokeSession(): Promise<void> {}
}

class Provider implements DingTalkProvider {
  buildQrAuthorizationUrl(state: string): string {
    return `https://login.example/oauth?state=${encodeURIComponent(state)}`;
  }
  async exchangeMobileCode(code: string): Promise<DingTalkIdentity> {
    return { userId: code, unionId: `union-${code}`, corpId: "corp-a" };
  }
  async exchangeQrCode(code: string): Promise<DingTalkIdentity> {
    return this.exchangeMobileCode(code);
  }
  async getOrganizationMember(identity: DingTalkIdentity): Promise<OrganizationMember> {
    return {
      corpId: "corp-a",
      userId: identity.userId,
      unionId: identity.unionId,
      active: true,
      employed: true,
      displayName: "达兴员工",
    };
  }
}

function createApp(): { app: FastifyInstance; store: MemoryStore } {
  const store = new MemoryStore();
  const auth = new AuthService(new Provider(), store, "corp-a", 60_000, config.sessionSecret);
  const app = buildApp({
    config,
    auth,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
  });
  apps.push(app);
  return { app, store };
}

const stateHash = (state: string): string => createHash("sha256").update(state).digest("hex");

describe("ERP-style embedded DingTalk QR login", () => {
  it("publishes only public frame configuration and completes through the initiating browser", async () => {
    const { app, store } = createApp();
    const start = await app.inject({ method: "POST", url: "/auth/qr/start" });

    expect(start.statusCode).toBe(200);
    expect(start.body).not.toContain("bindingToken");
    expect(start.headers["set-cookie"]).toContain("dx_rework_qr_binding=");

    const body = start.json<{
      authorizationUrl: string;
      frame: {
        clientId: string;
        redirectUri: string;
        state: string;
        scope: string;
        responseType: string;
        prompt: string;
      };
    }>();
    expect(body.frame).toEqual({
      clientId: "web-client",
      redirectUri: "https://example.test/rework/auth/qr/relay",
      state: body.frame.state,
      scope: "openid corpid",
      responseType: "code",
      prompt: "consent",
    });
    expect(new URL(body.authorizationUrl).searchParams.get("state")).toBe(body.frame.state);
    expect(store.states.has(stateHash(body.frame.state))).toBe(true);

    const wrongBrowser = await app.inject({
      method: "POST",
      url: "/auth/qr/complete",
      headers: { cookie: "dx_rework_qr_binding=wrong" },
      payload: { authCode: "qr-code", state: body.frame.state },
    });
    expect(wrongBrowser.statusCode).toBe(401);
    expect(wrongBrowser.json().error.code).toBe("INVALID_QR_STATE");

    const bindingCookie = String(start.headers["set-cookie"]).split(";")[0];
    const complete = await app.inject({
      method: "POST",
      url: "/auth/qr/complete",
      headers: { cookie: bindingCookie },
      payload: { authCode: "qr-code", state: body.frame.state },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("authorized");
    expect(complete.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("dx_rework_qr_binding=;"),
      expect.stringContaining("dx_rework_session="),
    ]));
    expect(store.sessions).toHaveLength(1);

    const replay = await app.inject({
      method: "POST",
      url: "/auth/qr/complete",
      headers: { cookie: bindingCookie },
      payload: { code: "second-code", state: body.frame.state },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("INVALID_QR_STATE");
  });
});
