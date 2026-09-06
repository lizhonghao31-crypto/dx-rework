import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SampleCapabilitySchema, SampleListQuerySchema, SampleStatusSchema, projectSampleView } from "../../packages/contracts/src/samples.js";
import { canUseSampleCapability, SAMPLE_ROLE_CAPABILITIES } from "../../apps/api/src/samples/sample-authority.js";
import { inventorySampleSource, parseSampleSource, sampleMoneyCents, sampleMoneyText, sampleSourceHash, stageSampleSource } from "../../apps/api/src/samples/sample-migration.js";
import type { Pool } from "pg";

const userId = randomUUID();
const sample = (overrides: Record<string, unknown> = {}) => ({
  id: "legacy-1", sampleCode: "YI-202609-0001", status: "BORROWED", brand: "test", styleName: "test",
  color: "blue", department: "design", purchaseDate: "2026-09-01", purchasePrice: "10.01",
  purchaser: "Legacy purchaser", currentHolder: "Legacy holder", borrowHistory: [{}], disposalHistory: [],
  receiptImages: [{ objectKey: "daxing-sample/receipts/test.png", url: "https://daxing-sample-media.oss-cn-hangzhou.aliyuncs.com/daxing-sample/receipts/test.png?private-signature=must-not-appear" }],
  ...overrides,
});
const source = (samples = [sample()]) => ({ samples, logs: [], borrowRequests: [], updatedAt: "2026-09-01T00:00:00.000Z" });
const actor = (role: string, capabilities: readonly string[]) => ({ actorId: userId, actorRoles: [role], authorizationCapability: "sample:view_basic", authorizationCapabilities: capabilities, requestId: "test" });

describe("sample foundation authority and field boundaries", () => {
  it.each(Object.entries(SAMPLE_ROLE_CAPABILITIES))("enforces every allowed and denied capability for %s", (role, allowed) => {
    // Even an overbroad capability list cannot elevate a designer/admin/finance into a business owner.
    for (const capability of SampleCapabilitySchema.options) {
      expect(canUseSampleCapability(actor(role, SampleCapabilitySchema.options), capability)).toBe(allowed.includes(capability));
      expect(canUseSampleCapability(actor(role, []), capability)).toBe(false);
    }
  });
  it("keeps root distinct from system_admin and unrelated business roles", () => {
    for (const capability of SampleCapabilitySchema.options) {
      expect(canUseSampleCapability(actor("system_admin", SampleCapabilitySchema.options), capability)).toBe(false);
      expect(canUseSampleCapability(actor("worker", SampleCapabilitySchema.options), capability)).toBe(false);
      expect(canUseSampleCapability(actor("root_superuser", []), capability)).toBe(true);
    }
  });
  it("never returns finance fields or future extra fields in a basic projection", () => {
    const row = { sampleId: randomUUID(), sampleCode: "YI-202609-0001", status: "borrowed", version: 1,
      brand: "test", styleName: "test", styleNo: "", category: "", color: "blue", size: "", department: "design",
      purchaseDate: "2026-09-01", purchaserUserId: userId, purchaserName: "test", holderUserId: userId,
      holderName: "test", purpose: "test", borrowedAt: "2026-09-01", storageLocation: null, remark: "",
      createdAt: "2026-09-01", updatedAt: "2026-09-01", finance: { purchasePrice: "10.01", receiptAttachmentIds: [] },
      futureSensitiveField: "must not leak", purchase_price: "10.01" };
    const basic = projectSampleView(row, false);
    expect(basic).not.toHaveProperty("finance");
    expect(basic).not.toHaveProperty("purchase_price");
    expect(basic).not.toHaveProperty("futureSensitiveField");
    expect(projectSampleView(row, true).finance?.purchasePrice).toBe("10.01");
  });
  it("uses fixed server pagination and known states", () => {
    expect(SampleListQuerySchema.parse({})).toMatchObject({ page: 1, view: "borrowed" });
    expect(SampleListQuerySchema.safeParse({ pageSize: 10000 }).success).toBe(false);
    expect(SampleListQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(SampleStatusSchema.safeParse("arbitrary-state").success).toBe(false);
  });
});

describe("sample migration inventory", () => {
  it("uses exact decimal sums and rejects ambiguous or invalid amounts", () => {
    expect(sampleMoneyText(sampleMoneyCents(0.1) + sampleMoneyCents("0.20"))).toBe("0.30");
    for (const value of [-1, "1e3", "0.001", "NaN", "", null, "9999999999999.00"]) expect(() => sampleMoneyCents(value)).toThrow();
    const { report } = inventorySampleSource(source([sample({ purchasePrice: "bad" })]));
    expect(report.amountComplete).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "INVALID_AMOUNT" }));
  });
  it("is deterministic, retains histories and excludes legacy credentials/settings/sessions", () => {
    const input = { ...source(), settings: { rolePasswords: "not-migrated" }, users: [{ password: "not-migrated" }], qrSessions: ["expired"] };
    const result = inventorySampleSource(input);
    expect(result.source).not.toHaveProperty("settings");
    expect(result.source).not.toHaveProperty("users");
    expect(result.source).not.toHaveProperty("qrSessions");
    expect(result.source.samples[0]?.borrowHistory).toEqual([{}]);
    expect(sampleSourceHash({ a: 1, b: 2 })).toBe(sampleSourceHash({ b: 2, a: 1 }));
    expect(result.report.sourceHash).toBe(inventorySampleSource(input).report.sourceHash);
    expect(result.report.readyForImport).toBe(false);
    expect(result.report.issues).toContainEqual(expect.objectContaining({ code: "IDENTITY_MAPPING_REQUIRED", field: "currentHolder" }));
  });
  it("deduplicates signed URLs and keys without exposing signatures or accepting foreign objects", () => {
    const report = inventorySampleSource(source([sample({ receiptImage: "https://daxing-sample-media.oss-cn-hangzhou.aliyuncs.com/daxing-sample/receipts/test.png?signature=other",
      sampleImages: ["https://example.com/private.png", "daxing-sample/../escape.png"] })])).report;
    expect(report.attachments).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("signature");
    expect(report.issues.filter((issue) => issue.code === "INVALID_ATTACHMENT_REFERENCE")).toHaveLength(2);
  });
  it("does not guess DISPOSED types, silently discard orphan logs or accept duplicate legacy IDs", () => {
    const input = { ...source([sample({ status: "DISPOSED", receiptImages: [] })]), logs: [{ id: "orphan", sampleId: "unknown" }] };
    const report = inventorySampleSource(input).report;
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["DISPOSED_REQUIRES_EXPLICIT_TYPE", "MISSING_RECEIPT", "ORPHAN_HISTORY"]));
    expect(() => parseSampleSource(source([sample(), sample()]))).toThrow("Duplicate legacy sample ID");
    expect(() => parseSampleSource({ samples: [] })).toThrow();
  });
  it("rejects staging before any database connection for every non-root role", async () => {
    for (const role of ["owner_group", "sample_finance", "sample_administrative", "sample_designer", "system_admin"]) {
      await expect(stageSampleSource({} as Pool, actor(role, SampleCapabilitySchema.options), source())).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("matches SQL grants to the server allowlist, without granting root-only capabilities", async () => {
    const sql = await readFile("apps/api/migrations/0152_sample_domain_foundation.sql", "utf8");
    for (const [role, allowed] of Object.entries(SAMPLE_ROLE_CAPABILITIES)) {
      for (const capability of SampleCapabilitySchema.options) expect(sql.includes(`('${role}','${capability}')`)).toBe(allowed.includes(capability));
    }
    expect(sql).not.toContain("('system_admin','sample:");
    expect(sql).toContain("sample_request_one_active_idx");
    expect(sql).toContain("sample_custody_one_open_idx");
  });
});
