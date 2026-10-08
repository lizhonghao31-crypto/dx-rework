import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("versioned sourcing craft catalog", () => {
  const schema = `craft_catalog_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const actorId = randomUUID();
  const service = new AccessMasterDataService(database, "corp");
  const sourcingService = new SourcingService(database);

  const actor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId,
    actorRoles: ["system_admin"],
    authorizationCapability: "master_data:manage",
    requestId,
  });

  const sourcingActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId,
    actorRoles: ["order_merchandiser"],
    authorizationCapability: "sourcing:inquiry:create",
    authorizationCapabilities: ["sourcing:view", "sourcing:inquiry:create"],
    requestId,
  });

  beforeAll(async () => {
    await adminDatabase.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    await database.query(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY, checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const migrationClient = await database.connect();
    try {
      for (const migration of manifest.migrations) {
        await migrationClient.query("BEGIN");
        try {
          const sql = await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8");
          await migrationClient.query(sql);
          await migrationClient.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version,migration.checksum]);
          await migrationClient.query("COMMIT");
        } catch (error) { await migrationClient.query("ROLLBACK"); throw error; }
      }
    } finally { migrationClient.release(); }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'工艺管理员',true)",
      [actorId],
    );
  }, 120_000);

  afterAll(async () => {
    await database.end();
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminDatabase.end();
  });

  it("creates node 1 without crafts and deduplicates its style catalog", async () => {
    const input = {
      gender: "男装" as const,styleName: "梭织短裤",estimatedCutPieceSendDate: "2026-09-25",deliveryDate: "2026-09-30",
      lineItems: [{styleNo: "CRAFT-001",color: "黑色",quantity: 80,externalUnitPrice: "12.0000"}],daxingUnitPrice: "10.0000",
    };
    const [first, second] = await Promise.all([
      sourcingService.createCase(sourcingActor("order-create-1"), input, "order-1"),
      sourcingService.createCase(sourcingActor("order-create-2"), { ...input,styleName: "  梭织短裤  ",lineItems: [{...input.lineItems[0]!,styleNo:"CRAFT-002"}] }, "order-2"),
    ]);
    expect(first.value).toMatchObject({ gender: "男装",styleName: "梭织短裤",processes: [],crafts: [] });
    expect(second.value).toMatchObject({ gender: "男装",styleName: "梭织短裤",processes: [],crafts: [] });
    expect(first.value.sourcingCaseId).not.toBe(second.value.sourcingCaseId);
    expect((await database.query("SELECT * FROM sourcing_style_catalog")).rowCount).toBe(1);
    expect((await database.query("SELECT * FROM sourcing_case_crafts")).rowCount).toBe(0);
    await expect(database.query("UPDATE sourcing_style_catalog SET style_name='改名'"))
      .rejects.toMatchObject({ code: "55000" });
  });

  it("creates, revises, disables and reads immutable audit history", async () => {
    const [created] = await service.ensureCrafts(actor("craft-create"), { craftNames: ["水洗"] });
    expect(created).toMatchObject({
      version: 1,
      craftName: "水洗",
      active: true,
    });

    await service.reviseCraft(actor("craft-revise"), created!.craftId, {
      craftName: "成衣水洗",
      active: false,
      changeReason: "暂停新订单使用",
    });

    expect(await service.listCrafts()).toEqual([]);
    expect(await service.listCrafts("", true)).toEqual([
      expect.objectContaining({
        craftId: created!.craftId,
        version: 2,
        craftName: "成衣水洗",
        active: false,
      }),
    ]);
    expect(await service.listCraftHistory(created!.craftId)).toEqual([
      expect.objectContaining({
        version: 2,
        changeReason: "暂停新订单使用",
        changedBy: actorId,
      }),
      expect.objectContaining({
        version: 1,
        changeReason: "外发订单业务页新增工艺",
        changedBy: actorId,
      }),
    ]);

    const audit = await database.query<{ action: string; reason: string }>(
      `SELECT action,reason FROM operation_events
       WHERE entity_type='craft_catalog' AND entity_id=$1
       ORDER BY created_at,event_id`,
      [created!.craftId],
    );
    expect(audit.rows).toEqual([
      expect.objectContaining({ action: "master_data.craft.create" }),
      { action: "master_data.craft.revise", reason: "暂停新订单使用" },
    ]);

    await expect(database.query(
      "UPDATE craft_catalog_versions SET active=true WHERE craft_id=$1 AND version=2",
      [created!.craftId],
    )).rejects.toMatchObject({ code: "55000" });
  });
});
