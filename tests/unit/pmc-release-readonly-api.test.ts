import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { canUseCutting, isPmcOnly, PMC_READ_CAPABILITIES, pmcEffectiveCapabilities } from "@dx-rework/contracts";
import { businessRoleLabel } from "@dx-rework/contracts/business-display";
import { hasFinanceWageMarkRole, hasFinanceWageRole } from "@dx-rework/contracts/finance-access";
import { canUsePatternOrder } from "@dx-rework/contracts/pattern-orders";
import { canUsePatternPrice } from "@dx-rework/contracts/pattern-room";
import { assertBusinessExportAllowed } from "../../apps/api/src/access/export-authority.js";
import { canReadDaxingPrice, canReadSupplierContactData, canReadSupplierContractData, canReadSupplierPaymentData } from "../../apps/api/src/access/permission-sensitive-field-policy.js";
import { registerPmcReadonlyHttpGuard } from "../../apps/api/src/access/pmc-readonly-http.js";
import { registerSupplierOnboardingRoutes, type SupplierOnboardingDependencies } from "../../apps/api/src/access/supplier-onboarding-routes.js";
import { registerPatternRoomPriceRoutes, type PatternRoomPriceDependencies } from "../../apps/api/src/pattern-room/price-routes.js";
import { ResponsibilityDeterminationQueueService } from "../../apps/api/src/rework/responsibility-determination-queue-service.js";
import { canReadReworkHistoryNode } from "../../apps/api/src/rework/rework-node-history.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import type { OperationEventRepository, TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { registerToolsRoutes, type ToolsHttpDependencies } from "../../apps/api/src/tools/routes.js";
import type { ObjectStorage } from "../../apps/api/src/tools/storage.js";

// Explicit approved reads; this is not derived from the manager's mutable grants.
const reads = ["cutting:orders:view", "dashboard:management:read", "external_responsibility:view", "own_factory:view",
  "pattern_room:catalog:read", "pattern_room:misc:quote", "pattern_room:orders:view", "pattern_room:prices:read",
  "people:read", "process_catalog:read", "receiving:export", "report:export", "report:view", "sourcing:view",
  "supplier_catalog:read", "supplier_contract_data:read", "supplier_profile:read", "todo:view", "wage:export", "wage:view",
  "tools:read", "supplier_onboarding:read", "todo:routing_exception_read"];
const cookie = { cookie: "dx_rework_session=current-session" };
const actor = (roles = ["pmc"]): TrustedActorContext => ({ actorId: randomUUID(), actorRoles: roles,
  authorizationCapability: "tools:read", authorizationCapabilities: reads, requestId: "pmc-release-test" });

describe("release PMC contract and legacy read boundaries", () => {
  it("keeps the approved read set, miscellaneous quotation and independent label", () => {
    expect(PMC_READ_CAPABILITIES).toEqual(reads);
    expect(businessRoleLabel("pmc")).toBe("PMC");
    expect(canUsePatternPrice(["pmc"], reads, "pattern_room:misc:quote")).toBe(true);
    expect(canUsePatternPrice(["worker"], reads, "pattern_room:misc:quote")).toBe(false);
    expect(hasFinanceWageRole(["pmc"])).toBe(true);
    expect(hasFinanceWageMarkRole(["pmc"])).toBe(false);
  });

  it("does not turn forged write capabilities into role permission, while retaining real role unions", () => {
    expect(canUseCutting(["pmc"], reads, "cutting:orders:view")).toBe(true);
    expect(canUsePatternOrder(["pmc"], reads, "pattern_room:orders:view")).toBe(true);
    expect(canUseCutting(["pmc"], [...reads, "cutting:records:create"], "cutting:records:create")).toBe(false);
    expect(canUsePatternOrder(["pmc"], [...reads, "pattern_room:orders:complete"], "pattern_room:orders:complete")).toBe(false);
    expect(canUsePatternPrice(["pmc"], [...reads, "pattern_room:prices:write"], "pattern_room:prices:write")).toBe(false);
    expect(canUsePatternOrder(["pmc", "pattern_room_worker"], [...reads, "pattern_room:orders:complete"], "pattern_room:orders:complete")).toBe(true);
    expect(canUseCutting(["pmc", "cutting_worker"], [...reads, "cutting:records:create"], "cutting:records:create")).toBe(true);
    expect(canUsePatternPrice(["pmc", "production_management"], [...reads, "pattern_room:prices:write"], "pattern_room:prices:write")).toBe(true);
    expect(pmcEffectiveCapabilities(["pmc"], [...reads, "work:report", "tools:user"])).toEqual(reads);
    expect(pmcEffectiveCapabilities(["pmc", "worker"], [...reads, "work:report", "tools:user"])).toEqual([...reads, "work:report", "tools:user"]);
    expect(pmcEffectiveCapabilities(["pmc"], [...reads, "tools:user"], true)).toEqual([...reads, "tools:user"]);
    expect(isPmcOnly([])).toBe(false);
  });

  it("matches approved sensitive-field and export reads without expanding other roles", () => {
    for (const role of ["pmc", "production_management"]) {
      for (const allowed of [canReadDaxingPrice, canReadSupplierContactData, canReadSupplierContractData, canReadSupplierPaymentData]) {
        expect(allowed([role], false)).toBe(true);
      }
      for (const capability of ["report:export", "receiving:export", "wage:export"]) {
        expect(() => assertBusinessExportAllowed([role], capability)).not.toThrow();
      }
    }
    expect(canReadDaxingPrice(["finance_read"], false)).toBe(false);
    expect(canReadSupplierPaymentData(["worker"], false)).toBe(false);
    expect(() => assertBusinessExportAllowed(["worker"])).toThrow();
    expect(canReadReworkHistoryNode(actor(), "responsibility")).toBe(true);
    expect(canReadReworkHistoryNode(actor(), "owner_signature")).toBe(true);
    expect(canReadReworkHistoryNode(actor(), "work_reporting")).toBe(false);
    expect(canReadReworkHistoryNode({ ...actor(), authorizationCapabilities: [] }, "responsibility")).toBe(false);
  });

  it("requires a persisted direct PMC role before returning responsibility queue records", async () => {
    const query = vi.fn(async () => ({ rows: [{ allowed: false }] }));
    const queue = new ResponsibilityDeterminationQueueService({ query } as unknown as Pool);
    expect(await queue.list(actor())).toEqual({ items: [] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SELECT responsibility_actor_has_direct_role($1,'external_responsibility:view',ARRAY['pmc']) allowed", [expect.any(String)]);
  });

  it("keeps the existing miscellaneous hourly quotation HTTP read available", async () => {
    const app = Fastify(), quote = vi.fn(async () => ({ amount: "1.000" }));
    const authenticate = async () => ({ id: randomUUID(), displayName: "PMC测试", businessRoles: ["pmc"], capabilities: reads });
    registerPmcReadonlyHttpGuard(app, authenticate);
    registerPatternRoomPriceRoutes(app, { authenticate, service: { quote } } as unknown as PatternRoomPriceDependencies);
    try {
      expect((await app.inject({ method: "GET", url: "/pattern-room/hourly-quote", headers: cookie })).statusCode).toBe(200);
      expect(quote).toHaveBeenCalledWith(expect.objectContaining({ actorRoles: ["pmc"], authorizationCapability: "pattern_room:misc:quote" }), "hourly", expect.any(String));
    } finally { await app.close(); }
  });
});

describe("release PMC authenticated HTTP mutation boundary", () => {
  it("rejects direct digital and legacy writes despite forged headers, body roles and write grants", async () => {
    const app = Fastify(), called = vi.fn(async () => ({ ok: true }));
    const authenticate = vi.fn(async () => ({ id: "real-pmc", displayName: "root", businessRoles: ["pmc"], capabilities: [...reads, "tools:user", "work:report"] }));
    const root = vi.fn(async () => false);
    registerPmcReadonlyHttpGuard(app, authenticate, root);
    const writes = ["/sourcing/cases", "/master-data/suppliers", "/work-reports/batch", "/digital-production/orders",
      "/digital-production/development/orders/x/plot/upload-intents", "/todos/mine/x/read", "/todos/routing-exceptions/x/transfer", "/auth/unrecognized-business-mutation",
      "/acceptance/control/reset", "/acceptance/control/switch-extra", "/acceptance/control/start/extra", "/acceptance/clock/scenarios"];
    for (const url of writes) app.post(url, called);
    for (const method of ["PUT", "PATCH", "DELETE"] as const) app.route({ method, url: "/digital-production/orders/x", handler: called });
    try {
      for (const url of writes) {
        const response = await app.inject({ method: "POST", url, headers: { ...cookie, "x-business-roles": "root_superuser,worker" }, payload: { businessRoles: ["root_superuser"], isRoot: true } });
        expect(response.statusCode, url).toBe(403);
        expect(response.json().message).toBe("PMC仅可查看，不能执行业务操作");
      }
      for (const method of ["PUT", "PATCH", "DELETE"] as const) expect((await app.inject({ method, url: "/digital-production/orders/x", headers: cookie })).statusCode).toBe(403);
      expect(called).not.toHaveBeenCalled();
      expect(authenticate).toHaveBeenCalledWith("current-session");
      expect(root).toHaveBeenCalledWith("real-pmc");
    } finally { await app.close(); }
  });

  it("keeps exact auth, Lab identity-control and export-read POSTs and GET queries available", async () => {
    const app = Fastify();
    registerPmcReadonlyHttpGuard(app, async () => ({ id: "pmc", displayName: "PMC测试", businessRoles: ["pmc"], capabilities: reads }));
    const readPosts = ["/auth/logout", "/auth/mobile", "/auth/qr/start", "/auth/qr/complete", "/tools/exports", "/access/data-export/authorize",
      "/acceptance/control/start", "/acceptance/control/switch", "/acceptance/control/end"];
    for (const url of readPosts) app.post(url, async () => ({ ok: true }));
    app.get("/digital-production/cockpit", async () => ({ ok: true }));
    try {
      for (const url of readPosts) expect((await app.inject({ method: "POST", url: `${url}?context=pmc`, headers: cookie })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/digital-production/cockpit", headers: cookie })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it.each([
    { roles: ["pmc", "worker"], root: false },
    { roles: ["pmc"], root: true },
    { roles: ["production_management"], root: false },
  ])("preserves the existing native path for $roles with real Root=$root", async ({ roles, root }) => {
    const app = Fastify();
    registerPmcReadonlyHttpGuard(app, async () => ({ id: "trusted-user", displayName: "岗位测试", businessRoles: roles, capabilities: [] }), async () => root);
    app.post("/work-reports/batch", async () => ({ delegatedToExistingAuthorization: true }));
    try { expect((await app.inject({ method: "POST", url: "/work-reports/batch", headers: cookie })).statusCode).toBe(200); }
    finally { await app.close(); }
  });
});

describe("release PMC Tools and supplier application boundaries", () => {
  it("refuses uploads/finalization before handlers, even if tools:user was injected", async () => {
    const upload = vi.fn(), finalize = vi.fn();
    for (const capabilities of [reads, [...reads, "tools:user"]]) {
      const app = Fastify();
      registerToolsRoutes(app, { authenticate: async () => ({ id: randomUUID(), displayName: "PMC测试", businessRoles: ["pmc"], capabilities }),
        attachments: { createUploadIntent: upload, finalize }, exports: {},
      } as unknown as ToolsHttpDependencies);
      try {
        expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", payload: {} })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: `/tools/attachments/${randomUUID()}/finalize` })).statusCode).toBe(403);
      } finally { await app.close(); }
    }
    expect(upload).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it.each([{ roles: ["pmc"], root: true }, { roles: ["pmc", "worker"], root: false }])("keeps authorized attachment writes for $roles, Root=$root", async ({ roles, root }) => {
    const app = Fastify(), upload = vi.fn(async () => ({ ok: true }));
    registerToolsRoutes(app, { authenticate: async () => ({ id: randomUUID(), displayName: "岗位测试", businessRoles: roles, capabilities: ["tools:user"] }),
      isRootUser: async () => root, attachments: { createUploadIntent: upload }, exports: {},
    } as unknown as ToolsHttpDependencies);
    try {
      expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", payload: { filename: "proof.png", mimeType: "image/png", sizeBytes: 10, sha256: "a".repeat(64) } })).statusCode).toBe(201);
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({ actorRoles: root ? ["pmc", "root_superuser"] : roles }), expect.any(Object));
    } finally { await app.close(); }
  });

  it("also rejects direct attachment service writes, including release-only budget copy and PLT upload", async () => {
    const query = vi.fn(), connect = vi.fn(), storage = { createExactSizeNonOverwritableUploadGrant: vi.fn(), writeImmutable: vi.fn() };
    const service = new AttachmentService({ query, connect } as unknown as Pool, storage as unknown as ObjectStorage,
      { prefix: "unit", ttlSeconds: 60, maxUploadBytes: 100 });
    const trusted = actor();
    await expect(service.createUploadIntent(trusted, { filename: "a.png", mimeType: "image/png", sizeBytes: 1, sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.finalize(trusted, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.createTechnicalPlotUploadIntent(trusted, randomUUID(), randomUUID(), {})).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.copyDigitalBudgetImage(trusted, randomUUID(), 1, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    expect(storage.createExactSizeNonOverwritableUploadGrant).not.toHaveBeenCalled(); expect(storage.writeImmutable).not.toHaveBeenCalled();
  });

  it("retains attachment entity checks and export ownership through the actual read services", async () => {
    const trusted = actor(), attachmentId = randomUUID(), exportId = randomUUID();
    const row = { attachment_id: attachmentId, object_key: "private/test", original_filename: "proof.pdf", mime_type: "application/pdf",
      size_bytes: "10", sha256: "a".repeat(64), uploaded_by: randomUUID(), entity_type: "sourcing_case", entity_id: randomUUID(), status: "ready", created_at: new Date() };
    const exportRow = { export_job_id: exportId, requested_by: randomUUID(), export_type: "report", filters: {}, status: "succeeded", result_attachment_id: attachmentId, created_at: new Date() };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("SELECT * FROM attachments")) return { rows: [row], rowCount: 1 };
      if (sql.startsWith("SELECT * FROM export_jobs")) return { rows: [exportRow], rowCount: 1 };
      if (sql.startsWith("SELECT 1 FROM export_jobs")) return { rows: [], rowCount: values?.[1] === exportRow.requested_by ? 1 : 0 };
      throw new Error("Unexpected pool read");
    });
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
    const storage = { createDownloadGrant: vi.fn(async () => ({ downloadUrl: "https://example.invalid/private", expiresAt: "2026-11-02T00:00:00Z" })) };
    const append = vi.fn(async () => randomUUID());
    const attachments = new AttachmentService(pool, storage as unknown as ObjectStorage, { prefix: "unit", ttlSeconds: 60, maxUploadBytes: 100 }, { append } as unknown as OperationEventRepository);
    const canDownloadBoundAttachment = vi.fn(async () => false);
    const app = Fastify();
    registerToolsRoutes(app, { authenticate: async () => ({ id: trusted.actorId, displayName: "PMC测试", businessRoles: ["pmc"], capabilities: reads }),
      attachments, exports: new ExportJobService(pool), canDownloadBoundAttachment });
    try {
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${attachmentId}/download` })).statusCode).toBe(403);
      expect(storage.createDownloadGrant).not.toHaveBeenCalled();
      canDownloadBoundAttachment.mockResolvedValue(true);
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${attachmentId}/download` })).statusCode).toBe(200);
      expect(canDownloadBoundAttachment).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: trusted.actorId, actorRoles: ["pmc"] }), expect.objectContaining({ entityType: "sourcing_case", entityId: row.entity_id }));
      row.entity_type = "export_job"; row.entity_id = exportId;
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${attachmentId}/download` })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `/tools/exports/${exportId}` })).statusCode).toBe(403);
      exportRow.requested_by = trusted.actorId;
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${attachmentId}/download` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/tools/exports/${exportId}` })).statusCode).toBe(200);
      expect(storage.createDownloadGrant).toHaveBeenCalledTimes(2);
      expect(append).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it("allows supplier application reads but rejects approval, return and creation with forged capabilities", async () => {
    const app = Fastify(), list = vi.fn(async () => []), decide = vi.fn(), submit = vi.fn();
    registerSupplierOnboardingRoutes(app, { authenticate: async () => ({ id: randomUUID(), displayName: "PMC测试", businessRoles: ["pmc"], capabilities: [...reads, "supplier_onboarding:approve", "supplier_onboarding:request"] }),
      root: { isRootUser: async () => false }, service: { list, decide, submit },
    } as unknown as SupplierOnboardingDependencies);
    try {
      expect((await app.inject({ method: "GET", url: "/supplier-onboarding/requests?scope=all" })).statusCode).toBe(200);
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ actorRoles: ["pmc"], authorizationCapability: "supplier_onboarding:read" }), "all");
      for (const suffix of ["", `/${randomUUID()}/approve`, `/${randomUUID()}/return`]) {
        expect((await app.inject({ method: "POST", url: `/supplier-onboarding/requests${suffix}`, payload: {} })).statusCode).toBe(403);
      }
      expect(decide).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
