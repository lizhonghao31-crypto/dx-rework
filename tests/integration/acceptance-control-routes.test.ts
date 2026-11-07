import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAuthRoutes } from "../../apps/api/src/auth/routes.js";
import type { AuthService } from "../../apps/api/src/auth/service.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map(app => app.close())));

const create = (available: boolean, secureCookie = false) => {
  const auth = {
    acceptanceControlAvailable: vi.fn(() => available),
    beginAcceptanceControl: vi.fn(() => "control-token"),
    listAcceptanceIdentities: vi.fn(async () => [{
      alias: "worker-a", userId: "worker-id", displayName: "[UAT] 工人甲",
      active: true, employed: true, roleCodes: ["worker"], capabilities: ["work:report"],
    }]),
    switchAcceptanceIdentity: vi.fn(async () => ({
      token: "business-token",
      user: { id: "worker-id", displayName: "[UAT] 工人甲", businessRoles: ["worker"], capabilities: ["work:report"] },
    })),
    endAcceptanceControl: vi.fn(async () => undefined),
    loginMobile: vi.fn(), beginQr: vi.fn(), loginQr: vi.fn(), authenticate: vi.fn(), logout: vi.fn(),
  } as unknown as AuthService;
  const app = Fastify({ logger: false }); apps.push(app);
  registerAuthRoutes(app, auth, {
    secureCookie, ttlSeconds: 3600, appBasePath: "/", corpId: "corp-test",
    mobileClientId: "mobile", webClientId: "web", qrRedirectUri: "https://example.test/callback",
  });
  return { app, auth: auth as unknown as {
    beginAcceptanceControl: ReturnType<typeof vi.fn>;
    listAcceptanceIdentities: ReturnType<typeof vi.fn>;
    switchAcceptanceIdentity: ReturnType<typeof vi.fn>;
    endAcceptanceControl: ReturnType<typeof vi.fn>;
  } };
};

describe("acceptance control routes", () => {
  it("passes only the requesting browser's old business token to a successful role switch", async () => {
    const { app, auth } = create(true);
    const response = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: "dx_acceptance_control=control-token; dx_rework_session=this-browser" }, payload: { alias: "worker-a" } });
    expect(response.statusCode).toBe(200);
    expect(auth.switchAcceptanceIdentity).toHaveBeenCalledWith("control-token", "worker-a", "this-browser");
  });
  it("does not register any control endpoint for the official provider", async () => {
    const { app } = create(false); await app.ready();
    expect((await app.inject({ method: "GET", url: "/acceptance/control/status" })).statusCode).toBe(404);
  });

  it("keeps the controller cookie separate while replacing the tested business session", async () => {
    const { app, auth } = create(true); await app.ready();
    const start = await app.inject({ method: "POST", url: "/acceptance/control/start", payload: { code: "one-time" } });
    expect(start.statusCode).toBe(200);
    expect(start.headers["set-cookie"]).toContain("dx_acceptance_control=control-token");
    expect(start.headers["set-cookie"]).not.toContain("dx_rework_session");

    const controlCookie = "dx_acceptance_control=control-token";
    const status = await app.inject({ method: "GET", url: "/acceptance/control/status", headers: { cookie: controlCookie } });
    expect(status.statusCode).toBe(200);
    expect(auth.listAcceptanceIdentities).toHaveBeenCalledWith("control-token");

    const switched = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: controlCookie }, payload: { alias: "worker-a" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.headers["set-cookie"]).toContain("dx_rework_session=business-token");
    expect(switched.headers["set-cookie"]).not.toContain("dx_acceptance_control=");
    expect(auth.switchAcceptanceIdentity).toHaveBeenCalledWith("control-token", "worker-a", undefined);

    const ended = await app.inject({ method: "POST", url: "/acceptance/control/end", headers: { cookie: `${controlCookie}; dx_rework_session=business-token` } });
    expect(ended.statusCode).toBe(204);
    expect(ended.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("dx_acceptance_control=;"),
      expect.stringContaining("dx_rework_session=;"),
    ]));
    expect(auth.endAcceptanceControl).toHaveBeenCalledWith("control-token", "business-token");
  });
});

it("sets and clears both Acceptance cookies with Secure in HTTPS mode", async () => {
  const { app } = create(true, true);
  const start = await app.inject({ method: "POST", url: "/acceptance/control/start", payload: { code: "one-time" } });
  expect(start.headers["set-cookie"]).toContain("; Secure");
  const switched = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: "dx_acceptance_control=control-token" }, payload: { alias: "worker-a" } });
  expect(switched.headers["set-cookie"]).toContain("; Secure");
  const ended = await app.inject({ method: "POST", url: "/acceptance/control/end", headers: { cookie: "dx_acceptance_control=control-token; dx_rework_session=business-token" } });
  expect(ended.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringContaining("dx_acceptance_control=;"), expect.stringContaining("dx_rework_session=;")]));
  for (const cookie of ended.headers["set-cookie"] as unknown as string[]) expect(cookie).toContain("; Secure");
});
