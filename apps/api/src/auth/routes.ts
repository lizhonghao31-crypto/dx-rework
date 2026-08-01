import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthService } from "./service.js";

const COOKIE = "dx_rework_session";
const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, options: { secureCookie: boolean; ttlSeconds: number; appBasePath: string; corpId: string; mobileClientId: string }): void {
  const { secureCookie, ttlSeconds } = options;
  const cookiePath = options.appBasePath;
  const setSession = (token: string) => `${COOKIE}=${token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${secureCookie ? "; Secure" : ""}`;
  app.post<{ Body: { code?: string } }>("/auth/mobile", async (request, reply) => {
    const result = await auth.loginMobile(request.body?.code ?? "");
    return reply.header("set-cookie", setSession(result.token)).send({ user: result.user, status: result.user.capabilities.length ? "authorized" : "no_role" });
  });
  app.post("/auth/qr/start", async () => auth.beginQr());
  app.get("/auth/client-config", async () => ({ corpId: options.corpId, mobileClientId: options.mobileClientId }));
  app.get<{ Querystring: { authCode?: string; code?: string; state?: string } }>("/auth/qr/callback", async (request, reply) => {
    try {
      const result = await auth.loginQr(request.query.authCode ?? request.query.code ?? "", request.query.state ?? "");
      return reply.header("set-cookie", setSession(result.token)).code(303).header("location", options.appBasePath).send();
    } catch {
      return reply.code(303).header("location", `${options.appBasePath}auth/denied`).send();
    }
  });
  app.get("/auth/me", async (request) => {
    const user = await auth.authenticate(cookieToken(request));
    return { user, status: user.capabilities.length ? "authorized" : "no_role" };
  });
  app.post("/auth/logout", async (request, reply) => {
    await auth.logout(cookieToken(request));
    return reply.header("set-cookie", `${COOKIE}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`).code(204).send();
  });
  app.get("/api/protected", async (request, reply) => {
    const user = await auth.authenticate(cookieToken(request));
    if (!user.capabilities.length) return reply.code(403).send({ error: { code: "NO_BUSINESS_ROLE", message: "尚未分配业务角色，请联系管理员", requestId: request.id } });
    return { actorId: user.id };
  });
}
