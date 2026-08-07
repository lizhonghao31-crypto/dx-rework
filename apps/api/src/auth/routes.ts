import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthService } from "./service.js";

const COOKIE = "dx_rework_session";
const QR_COOKIE = "dx_rework_qr_binding";
const PUBLIC_LOGIN_LIMIT = 10;
const PUBLIC_LOGIN_WINDOW_MS = 60_000;
const PUBLIC_LOGIN_TRACKER_CAPACITY = 10_000;
const cookieToken = (request: FastifyRequest, name = COOKIE): string | undefined => request.headers.cookie?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);

type AuthRouteOptions = Readonly<{
  secureCookie: boolean;
  ttlSeconds: number;
  appBasePath: string;
  corpId: string;
  mobileClientId: string;
  webClientId: string;
  qrRedirectUri: string;
}>;

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, options: AuthRouteOptions): void {
  const { secureCookie, ttlSeconds } = options;
  const cookiePath = options.appBasePath;
  const setSession = (token: string) => `${COOKIE}=${token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${ttlSeconds}${secureCookie ? "; Secure" : ""}`;
  const setQrBinding = (bindingToken: string) => `${QR_COOKIE}=${bindingToken}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=300${secureCookie ? "; Secure" : ""}`;
  const clearQrBinding = `${QR_COOKIE}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? "; Secure" : ""}`;
  const loginAttempts = new Map<string, { count: number; resetsAt: number }>();
  const limitPublicLogin = async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    const key = `${request.ip}:${request.routeOptions.url}`;
    const current = loginAttempts.get(key);
    if (!current || current.resetsAt <= now) {
      if (!current && loginAttempts.size >= PUBLIC_LOGIN_TRACKER_CAPACITY) {
        for (const [candidate, value] of loginAttempts) {
          if (value.resetsAt <= now) loginAttempts.delete(candidate);
        }
        if (loginAttempts.size >= PUBLIC_LOGIN_TRACKER_CAPACITY) loginAttempts.delete(loginAttempts.keys().next().value!);
      }
      loginAttempts.set(key, { count: 1, resetsAt: now + PUBLIC_LOGIN_WINDOW_MS });
      return;
    }
    if (current.count >= PUBLIC_LOGIN_LIMIT) {
      return reply.header("retry-after", Math.max(1, Math.ceil((current.resetsAt - now) / 1000))).code(429).send({ error: { code: "RATE_LIMITED", message: "登录请求过于频繁，请稍后重试", requestId: request.id } });
    }
    current.count += 1;
  };
  app.post<{ Body: { code?: string } }>("/auth/mobile", { preHandler: limitPublicLogin }, async (request, reply) => {
    const result = await auth.loginMobile(request.body?.code ?? "");
    return reply.header("set-cookie", setSession(result.token)).send({ user: result.user, status: result.user.capabilities.length ? "authorized" : "no_role" });
  });
  app.post("/auth/qr/start", { preHandler: limitPublicLogin }, async (_request, reply) => {
    const result = await auth.beginQr();
    return reply.header("set-cookie", setQrBinding(result.bindingToken)).send({
      authorizationUrl: result.authorizationUrl,
      frame: {
        clientId: options.webClientId,
        redirectUri: options.qrRedirectUri,
        state: result.state,
        scope: "openid corpid",
        responseType: "code",
        prompt: "consent",
      },
    });
  });
  app.post<{ Body: { authCode?: string; code?: string; state?: string } }>("/auth/qr/complete", { preHandler: limitPublicLogin }, async (request, reply) => {
    const result = await auth.loginQr(
      request.body?.authCode ?? request.body?.code ?? "",
      request.body?.state ?? "",
      cookieToken(request, QR_COOKIE),
    );
    return reply
      .header("set-cookie", [clearQrBinding, setSession(result.token)])
      .send({ user: result.user, status: result.user.capabilities.length ? "authorized" : "no_role" });
  });
  app.get("/auth/client-config", async () => ({ corpId: options.corpId, mobileClientId: options.mobileClientId }));
  app.get<{ Querystring: { authCode?: string; code?: string; state?: string } }>("/auth/qr/callback", async (request, reply) => {
    try {
      const result = await auth.loginQr(request.query.authCode ?? request.query.code ?? "", request.query.state ?? "", cookieToken(request, QR_COOKIE));
      return reply.header("set-cookie", [clearQrBinding, setSession(result.token)]).code(303).header("location", options.appBasePath).send();
    } catch {
      request.log.warn({ requestId: request.id }, "QR callback denied");
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
  app.get("/protected", async (request, reply) => {
    const user = await auth.authenticate(cookieToken(request));
    if (!user.capabilities.length) return reply.code(403).send({ error: { code: "NO_BUSINESS_ROLE", message: "尚未分配业务角色，请联系管理员", requestId: request.id } });
    return { actorId: user.id };
  });
}
