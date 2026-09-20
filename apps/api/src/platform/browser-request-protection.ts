import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "./errors.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const normalizedOrigin = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const browserSite = (request: FastifyRequest): string | undefined => {
  const value = request.headers["sec-fetch-site"];
  return typeof value === "string" ? value.toLowerCase() : undefined;
};

export function registerBrowserMutationOriginGuard(
  app: FastifyInstance,
  trustedOrigin: string,
): void {
  const expected = normalizedOrigin(trustedOrigin);
  if (!expected || expected !== trustedOrigin) {
    throw new Error("Browser mutation guard requires an absolute origin");
  }

  app.addHook("preHandler", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;

    const originHeader = request.headers.origin;
    const origin = typeof originHeader === "string" ? normalizedOrigin(originHeader) : null;
    if (typeof originHeader === "string") {
      if (!origin || origin !== expected) {
        throw new ApplicationError(
          "CROSS_SITE_REQUEST_REJECTED",
          "跨站请求已拒绝，请从达兴数字助手页面重新操作",
          403,
        );
      }
      return;
    }

    const site = browserSite(request);
    if (site === "cross-site" || site === "same-site") {
      throw new ApplicationError(
        "CROSS_SITE_REQUEST_REJECTED",
        "跨站请求已拒绝，请从达兴数字助手页面重新操作",
        403,
      );
    }
  });
}
