import type { FastifyInstance } from "fastify";
import { isPmcOnly } from "@dx-rework/contracts";
import { authenticateForRequest, type RequestAuthenticator } from "../auth/request-identity-context.js";
import { ApplicationError } from "../platform/errors.js";

const AUTH_POSTS = new Set(["/auth/mobile", "/auth/qr/start", "/auth/qr/complete", "/auth/logout"]);
// These existing Lab identity controls keep their independent code/control-cookie
// validation. Official providers do not register them; no prefix is exempted.
const ACCEPTANCE_AUTH_POSTS = new Set(["/acceptance/control/start", "/acceptance/control/switch", "/acceptance/control/end"]);
// These POSTs perform the already-authorized export read, not a business transition.
const READ_POSTS = new Set(["/access/data-export/authorize", "/tools/exports"]);

export function registerPmcReadonlyHttpGuard(
  app: FastifyInstance,
  authenticate: RequestAuthenticator,
  isRoot: (id: string) => Promise<boolean> = async () => false,
): void {
  app.addHook("preHandler", async request => {
    const path = request.url.split("?", 1)[0]!;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || (request.method === "POST" && (AUTH_POSTS.has(path) || ACCEPTANCE_AUTH_POSTS.has(path)))
      || (request.method === "POST" && READ_POSTS.has(path))) return;
    const token = request.headers.cookie?.split(";").map(part => part.trim())
      .find(part => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    if (!token) return; // Existing public/authentication boundaries remain authoritative.
    const user = await authenticateForRequest(authenticate, token, request, "admission");
    if (isPmcOnly(user.businessRoles ?? []) && !await isRoot(user.id)) {
      throw new ApplicationError("FORBIDDEN", "PMC仅可查看，不能执行业务操作", 403);
    }
  });
}
