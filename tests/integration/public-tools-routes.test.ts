import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadConfig } from "@dx-rework/config";
import { buildApp } from "../../apps/api/src/app.js";
import { AuthDeniedError } from "../../apps/api/src/auth/service.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key",
  DINGTALK_H5_APP_SECRET: "secret",
  DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
});
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function create(
  capabilities: readonly string[] = ["tools:user"],
  businessRoles: readonly string[] | undefined = ["tail_supervisor"],
  canDownloadBoundAttachment = vi.fn(async () => false),
) {
  const attachments = {
    createUploadIntent: vi.fn(async (actor, input) => ({
      attachmentId: "00000000-0000-4000-8000-000000000001",
      objectKey: "private/key.pdf",
      uploadMethod: "POST",
      uploadUrl: "https://private.test/",
      uploadFields: { key: "private/key.pdf", policy: "signed" },
      expiresAt: new Date(0).toISOString(),
      actor,
      input,
    })),
    finalize: vi.fn(),
    createDownloadIntent: vi.fn(async () => ({
      downloadUrl: "https://private.test/attachment",
      expiresAt: new Date(0).toISOString(),
    })),
  };
  const exports = { create: vi.fn(), query: vi.fn(), isOwnedBy: vi.fn(async () => true) };
  const app = buildApp({
    config,
    checkDatabase: async () => {},
    getAppliedSchemaHistory: async () => null,
    tools: {
      authenticate: async (token) => {
        if (token !== "trusted") throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return {
          id: "00000000-0000-4000-8000-000000000099",
          displayName: "employee",
          capabilities,
          businessRoles,
        };
      },
      attachments: attachments as never,
      exports: exports as never,
      canDownloadBoundAttachment,
    },
  });
  apps.push(app);
  return { app, attachments, exports, canDownloadBoundAttachment };
}

describe("public tools routes", () => {
  it("requires a trusted session and derives actor server-side", async () => {
    const { app, attachments } = create();
    const payload = { filename: "proof.pdf", mimeType: "application/pdf", sizeBytes: 12, sha256: "a".repeat(64), uploadedBy: "attacker", actorRole: "admin" };
    const unauthenticated = await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", payload });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error).toMatchObject({ code: "AUTH_REQUIRED", message: "请先通过钉钉登录" });
    expect(unauthenticated.json().error.requestId).toBeTruthy();
    const response = await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: { cookie: "dx_rework_session=trusted" }, payload });
    expect(response.statusCode).toBe(400);
    expect(attachments.createUploadIntent).not.toHaveBeenCalled();
    delete (payload as { uploadedBy?: string }).uploadedBy;
    delete (payload as { actorRole?: string }).actorRole;
    expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: { cookie: "dx_rework_session=trusted", "x-request-id": "request-1" }, payload })).statusCode).toBe(201);
    expect(attachments.createUploadIntent.mock.calls[0]?.[0]).toEqual({ actorId: "00000000-0000-4000-8000-000000000099", actorRoles: ["tail_supervisor"], authorizationCapability: "tools:user", requestId: "request-1" });
  });

  it("rejects Tools access when the trusted authentication store has no business-role snapshot", async () => {
    const { app, attachments } = create(["tools:user"], []);
    const payload = { filename: "proof.pdf", mimeType: "application/pdf", sizeBytes: 12, sha256: "a".repeat(64) };
    const response = await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: { cookie: "dx_rework_session=trusted" }, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "NO_BUSINESS_ROLE" });
    expect(attachments.createUploadIntent).not.toHaveBeenCalled();
  });

  it("rejects authenticated organization members without a business capability", async () => {
    const { app, attachments, exports } = create([]);
    const payload = { filename: "proof.pdf", mimeType: "application/pdf", sizeBytes: 12, sha256: "a".repeat(64) };
    const response = await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: { cookie: "dx_rework_session=trusted" }, payload });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "NO_BUSINESS_ROLE" });
    expect(attachments.createUploadIntent).not.toHaveBeenCalled();
    expect(exports.create).not.toHaveBeenCalled();
  });

  it("rejects an unrelated business capability on every Tools route", async () => {
    const { app, attachments } = create(["rework:read"]);
    const response = await app.inject({ method: "GET", url: "/tools/attachments/00000000-0000-4000-8000-000000000001/download", headers: { cookie: "dx_rework_session=trusted" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: "FORBIDDEN" });
    expect(attachments.createDownloadIntent).not.toHaveBeenCalled();
  });

  it("authorizes an allowed requester-owned export binding", async () => {
    const { app, attachments, exports } = create(["tools:user"], ["owner_group"]);
    const response = await app.inject({ method: "GET", url: "/tools/attachments/00000000-0000-4000-8000-000000000001/download", headers: { cookie: "dx_rework_session=trusted" } });
    expect(response.statusCode).toBe(200);
    const trustedActor = attachments.createDownloadIntent.mock.calls[0]?.[0];
    expect(trustedActor).toMatchObject({ actorRoles: ["owner_group"], authorizationCapability: "tools:user" });
    const authorizeBound = attachments.createDownloadIntent.mock.calls[0]?.[2];
    expect(await authorizeBound({ entityType: "export_job", entityId: "00000000-0000-4000-8000-000000000002", uploadedBy: "worker" })).toBe(true);
    expect(await authorizeBound({ entityType: "rework", entityId: "00000000-0000-4000-8000-000000000003", uploadedBy: "worker" })).toBe(false);
    expect(exports.isOwnedBy).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000099", "00000000-0000-4000-8000-000000000002");
  });

  it("denies generic export jobs to non-allowlisted roles and permits an owner", async () => {
    const payload = { exportType: "business-data", filters: {}, idempotencyKey: "export-1" };
    const denied = create(["tools:user"], ["tail_supervisor"]);
    const deniedResponse = await denied.app.inject({ method: "POST", url: "/tools/exports", headers: { cookie: "dx_rework_session=trusted" }, payload });
    expect(deniedResponse.statusCode).toBe(403);
    expect(denied.exports.create).not.toHaveBeenCalled();

    const allowed = create(["tools:user"], ["owner_group"]);
    const allowedResponse = await allowed.app.inject({ method: "POST", url: "/tools/exports", headers: { cookie: "dx_rework_session=trusted" }, payload });
    expect(allowedResponse.statusCode).toBe(201);
    expect(allowed.exports.create).toHaveBeenCalledTimes(1);
  });

  it("redirects explicit preview and download navigations through the existing authorization path", async () => {
    const { app, attachments } = create();
    const preview = await app.inject({
      method: "GET",
      url: "/tools/attachments/00000000-0000-4000-8000-000000000001/download?mode=preview",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(preview.statusCode).toBe(302);
    expect(preview.headers.location).toBe("https://private.test/attachment");
    expect(attachments.createDownloadIntent.mock.calls[0]?.[3]).toBe("inline");

    const download = await app.inject({
      method: "GET",
      url: "/tools/attachments/00000000-0000-4000-8000-000000000001/download?mode=download",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(download.statusCode).toBe(302);
    expect(attachments.createDownloadIntent.mock.calls[1]?.[3]).toBe("attachment");
  });

  it("requires current QC role and rework capability before authorizing bound QC evidence", async () => {
    const { app, attachments, canDownloadBoundAttachment } = create(
      ["tools:user", "rework:initiate"],
      ["quality_control"],
      vi.fn(async () => false),
    );
    await app.inject({ method: "GET", url: "/tools/attachments/00000000-0000-4000-8000-000000000001/download", headers: { cookie: "dx_rework_session=trusted" } });
    const authorizeBound = attachments.createDownloadIntent.mock.calls[0]?.[2];
    await expect(authorizeBound({ attachmentId: "00000000-0000-4000-8000-000000000001", entityType: "rework_order", entityId: "00000000-0000-4000-8000-000000000003", mimeType: "image/webp", uploadedBy: "00000000-0000-4000-8000-000000000099" })).resolves.toBe(false);
    expect(canDownloadBoundAttachment).toHaveBeenCalledWith({
      actorId: "00000000-0000-4000-8000-000000000099",
      actorRoles: ["quality_control"],
      capabilities: ["tools:user", "rework:initiate"],
    }, { attachmentId: "00000000-0000-4000-8000-000000000001", entityType: "rework_order", entityId: "00000000-0000-4000-8000-000000000003", mimeType: "image/webp" });
  });

  it("rejects unsupported MIME, invalid hash and oversized/non-numeric request shapes", async () => {
    const { app } = create();
    for (const payload of [
      { filename: "x.exe", mimeType: "application/octet-stream", sizeBytes: 1, sha256: "a".repeat(64) },
      { filename: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "bad" },
      { filename: "x.pdf", mimeType: "application/pdf", sizeBytes: -1, sha256: "a".repeat(64) },
    ]) expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: { cookie: "dx_rework_session=trusted" }, payload })).statusCode).toBe(400);
  });
});
