import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SampleReadService } from "../../apps/api/src/samples/sample-read-service.js";
import { SampleCapabilitySchema } from "../../packages/contracts/src/samples.js";
import { OperationEventRepository } from "../../apps/api/src/tools/repositories.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = url ? describe : describe.skip;
run("sample read projections, paging and exact amounts", () => {
  const schema = `sample_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url! });
  const db = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
  const service = new SampleReadService(db), userId = randomUUID(), otherId = randomUUID();
  const actor = (role: string, id = userId) => ({ actorId: id, actorRoles: [role], authorizationCapability: "sample:view_basic",
    authorizationCapabilities: SampleCapabilitySchema.options, requestId: "sample-read-fixture" });
  const borrowed: string[] = [];
  let archived = "", pendingId = "", sold = "";
  const create = async (status: string, code: string, holder: string | null = userId) => {
    const id = randomUUID();
    await db.query(`INSERT INTO sample_items(sample_id,sample_code,status,brand,style_name,color,department,purchase_date,
      purchaser_user_id,purchaser_name,holder_user_id,holder_name,borrowed_at,storage_location,created_by,archived_from_status,archived_reason)
      VALUES($1,$2,$3,'测试品牌','测试样衣','蓝','设计','2026-09-01',$4,'测试采购人',$5,$6,CURRENT_TIMESTAMP,$7,$4,$8,$9)`,
    [id, code, status, userId, holder, holder ? "测试持有人" : null, status === "in_stock" || status === "borrow_pending" ? "A01" : null,
      status === "archived" ? "borrowed" : null, status === "archived" ? "fixture" : null]);
    await db.query("INSERT INTO sample_financial_facts(sample_id,purchase_price) VALUES($1,'100.01')", [id]);
    return id;
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql", "0004_public_tools_foundation.sql", "0005_access_master_data.sql", "0152_sample_domain_foundation.sql"]) {
      await db.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    }
    for (const id of [userId, otherId]) await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'样衣测试用户',true)", [id]);
    for (let i = 0; i < 31; i++) borrowed.push(await create("borrowed", `YI-fixture-${i}`));
    await create("in_stock", "YI-stock", null);
    pendingId = await create("borrow_pending", "YI-pending", null);
    await db.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,requested_for,purpose)
      VALUES($1,$2,'borrow','pending','in_stock',$3,$3,'测试借用')`, [randomUUID(), pendingId, otherId]);
    archived = await create("archived", "YI-archived");
    sold = await create("sold", "YI-sold", null);
    const sale = randomUUID();
    await db.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,resolved_by,resolved_at)
      VALUES($1,$2,'sale','completed','in_stock',$3,$3,'2026-09-02T02:00:00Z')`, [sale, sold, userId]);
    await db.query(`INSERT INTO sample_disposals(disposal_id,request_id,sample_id,disposal_type,proposed_amount,final_amount,approved_by,approved_at,recipient)
      VALUES($1,$2,$3,'sale','50.01','50.01',$4,'2026-09-02T02:00:00Z','测试买方')`, [randomUUID(), sale, sold, userId]);
    for (let i = 0; i < 17; i++) await db.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,returned_at,requested_by,initial_custody)
      VALUES($1,$2,$3,'历史测试人','设计','测试用途','2026-09-01T01:00:00Z','2026-09-01T02:00:00Z',$3,true)`, [randomUUID(), borrowed[0], userId]);
    const client = await db.connect();
    try { await new OperationEventRepository().append(client, actor("root_superuser"), { action: "sample.finance_corrected", entityType: "sample", entityId: borrowed[0]!,
      before: { purchasePrice: "SECRET_FINANCE_VALUE" }, after: { receiptUrl: "PRIVATE_RECEIPT_REFERENCE" }, reason: "SENSITIVE_REASON" }); }
    finally { client.release(); }
  });
  afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

  it.each(["sample_designer", "sample_administrative", "sample_finance", "owner_group", "root_superuser"])("paginates real rows and total for %s", async role => {
    const first = await service.list(actor(role), {}), second = await service.list(actor(role), { page: 2 }), third = await service.list(actor(role), { page: 3 });
    expect(first.totalCount).toBe(31); expect(first.items).toHaveLength(15); expect(second.items).toHaveLength(15); expect(third.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.sampleId)).size).toBe(31);
    expect((await service.list(actor(role), { page: 99 })).totalCount).toBe(31);
    expect((await service.list(actor(role), { page: 99 })).items).toEqual([]);
    expect(first.items[0]?.finance !== undefined).toBe(["sample_finance", "owner_group", "root_superuser"].includes(role));
  });
  it("denies technical administrators and ungranted identities before reading", async () => {
    for (const role of ["system_admin", "worker"]) {
      await expect(service.list(actor(role), {})).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.detail(actor(role), borrowed[0]!)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.options(actor(role))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.amounts(actor(role))).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("keeps procurement finance out of basic detail, histories and totals", async () => {
    for (const role of ["sample_designer", "sample_administrative"]) {
      expect((await service.detail(actor(role), borrowed[0]!)).item).not.toHaveProperty("finance");
      await expect(service.amounts(actor(role))).rejects.toMatchObject({ code: "FORBIDDEN" });
      const history = await service.history(actor(role), sold, { kind: "disposal" });
      expect(history.items[0]).not.toHaveProperty("amount");
    }
    await expect(service.history(actor("sample_designer"), borrowed[0]!, { kind: "audit" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const audit = JSON.stringify(await service.history(actor("sample_administrative"), borrowed[0]!, { kind: "audit" }));
    for (const sensitive of ["SECRET_FINANCE_VALUE", "PRIVATE_RECEIPT_REFERENCE", "SENSITIVE_REASON", "before_state", "after_state"]) expect(audit).not.toContain(sensitive);
    expect((await service.history(actor("sample_finance"), sold, { kind: "disposal" })).items[0]?.amount).toBe("50.01");
  });
  it("scopes pending work to executor capabilities and request participants", async () => {
    expect((await service.list(actor("sample_designer"), { view: "pending" })).totalCount).toBe(0);
    expect((await service.list(actor("sample_designer", otherId), { view: "pending" })).items[0]?.sampleId).toBe(pendingId);
    expect((await service.list(actor("sample_administrative"), { view: "pending" })).totalCount).toBe(1);
    expect((await service.list(actor("owner_group"), { view: "pending" })).totalCount).toBe(0);
    expect((await service.list(actor("root_superuser"), { view: "pending" })).totalCount).toBe(1);
  });
  it("filters literal search and disposal dates, preserves archived access and pages history", async () => {
    expect((await service.list(actor("sample_designer"), { search: "%' OR true --" })).totalCount).toBe(0);
    expect((await service.list(actor("sample_designer"), { purchaseYear: 2025 })).totalCount).toBe(0);
    expect((await service.list(actor("sample_designer"), { view: "disposed", disposalType: "sale", disposedFrom: "2026-09-02", disposedTo: "2026-09-02" })).items[0]?.sampleId).toBe(sold);
    expect((await service.list(actor("sample_designer"), { view: "disposed", disposedFrom: "2026-09-03" })).totalCount).toBe(0);
    await expect(service.detail(actor("sample_designer"), archived)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await service.detail(actor("root_superuser"), archived)).item.status).toBe("archived");
    const history = await service.history(actor("sample_designer"), borrowed[0]!, { page: 2 });
    expect(history.totalCount).toBe(17); expect(history.items).toHaveLength(2);
  });
  it("computes exact separate recovery totals and excludes archived original value", async () => {
    expect(await service.amounts(actor("sample_finance"))).toEqual({ purchaseTotal: "3400.34", managedOriginalValue: "3300.33", disposedOriginalValue: "100.01", saleReceipts: "50.01", lossCompensation: "0.00" });
  });
});
