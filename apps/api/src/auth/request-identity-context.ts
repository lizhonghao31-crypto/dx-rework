import type { FastifyRequest } from "fastify";
import type { AuthUser } from "./service.js";

export type RequestIdentityPhase = "admission" | "handler" | "response";
export type RequestIdentityContext = Readonly<{ request: object; phase: RequestIdentityPhase; fresh?: true }>;
export type RequestAuthenticator = (token: string | undefined, context?: RequestIdentityContext) => Promise<AuthUser>;

/** Only routes whose handler has no remote file generation/verification before
 * another write participate. Longer workflows retain their original fresh
 * authentication; attachment generation's final check is never included. */
export function requestIdentityPilot(method: string, path: string): boolean {
  if (["GET", "HEAD"].includes(method)) {
    return /^\/master-data\/suppliers(?:\/[^/.]+(?:\/history)?)?$/.test(path)
      || /^\/sourcing\/(?:cases(?:\/[^/]+(?:\/(?:attachments|timeline|history\/[^/]+))?)?|factories|styles|merchandisers|analysis)$/.test(path);
  }
  if (method !== "POST") return false;
  return /^\/master-data\/suppliers(?:\/[^/]+\/versions|\/import\/(?:preview|rows))?$/.test(path)
    || /^\/sourcing\/cases\/[^/]+\/(?:ie-quotes|management-decisions|budget-price-corrections|return-to-merchandiser|finance-reconciliations|exception-decisions)$/.test(path);
}

export function authenticateForRequest(
  authenticate: RequestAuthenticator,
  token: string | undefined,
  request: FastifyRequest,
  phase: RequestIdentityPhase,
): Promise<AuthUser> {
  const path = request.url.split("?", 1)[0]!;
  return requestIdentityPilot(request.method, path)
    ? authenticate(token, { request, phase, ...(phase === "handler" ? { fresh: true as const } : {}) })
    : authenticate(token);
}
