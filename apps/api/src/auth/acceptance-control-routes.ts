import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AcceptanceControlService } from "./acceptance-control.js";

const CONTROL_COOKIE = "dx_acceptance_control";
const BUSINESS_COOKIE = "dx_rework_session";

const cookieToken = (request: FastifyRequest, name: string): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export type AcceptanceControlRouteOptions = Readonly<{
  secureCookie: boolean;
  appBasePath: string;
  ttlSeconds: number;
}>;

export function registerAcceptanceControlRoutes(
  app: FastifyInstance,
  service: AcceptanceControlService,
  options: AcceptanceControlRouteOptions,
): void {
  const controlCookie = (token: string) =>
    `${CONTROL_COOKIE}=${token}; Path=${options.appBasePath}; HttpOnly; SameSite=Strict; Max-Age=28800${options.secureCookie ? "; Secure" : ""}`;
  const businessCookie = (token: string) =>
    `${BUSINESS_COOKIE}=${token}; Path=${options.appBasePath}; HttpOnly; SameSite=Lax; Max-Age=${options.ttlSeconds}${options.secureCookie ? "; Secure" : ""}`;
  const clearControl = `${CONTROL_COOKIE}=; Path=${options.appBasePath}; HttpOnly; SameSite=Strict; Max-Age=0${options.secureCookie ? "; Secure" : ""}`;
  const clearBusiness = `${BUSINESS_COOKIE}=; Path=${options.appBasePath}; HttpOnly; SameSite=Lax; Max-Age=0${options.secureCookie ? "; Secure" : ""}`;

  app.post<{ Body: { code?: string } }>("/acceptance/control/start", async (request, reply) => {
    const token = service.begin(request.body?.code ?? "");
    return reply.header("set-cookie", controlCookie(token)).send({ status: "ready" });
  });

  app.get("/acceptance/control/status", async (request) => ({
    status: "ready",
    identities: await service.listIdentities(cookieToken(request, CONTROL_COOKIE)),
  }));

  app.post<{ Body: { alias?: string } }>("/acceptance/control/switch", async (request, reply) => {
    const result = await service.switchIdentity(
      cookieToken(request, CONTROL_COOKIE),
      request.body?.alias ?? "",
    );
    return reply.header("set-cookie", businessCookie(result.token)).send({
      status: result.user.capabilities.length ? "authorized" : "no_role",
      user: result.user,
    });
  });

  app.post("/acceptance/control/end", async (request, reply) => {
    await service.end(
      cookieToken(request, CONTROL_COOKIE),
      cookieToken(request, BUSINESS_COOKIE),
    );
    return reply.header("set-cookie", [clearControl, clearBusiness]).code(204).send();
  });
}
