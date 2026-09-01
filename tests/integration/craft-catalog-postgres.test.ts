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
    for (const migration of manifest.migrations) {
      const sql = await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      );
      await database.query(sql);
    }
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

  it("binds only enabled crafts to new orders and preserves ordered snapshots", async () => {
    const [cutting, buttoning] = await service.ensureCrafts(actor("order-crafts"), {
      craftNames: ["裁片定位", "钉扣"],
    });

    const created = await sourcingService.createCase(sourcingActor("order-create"), {
      erpOrderNo: "ERP-CRAFT-001",
      styleNo: "CRAFT-001",
      deliveryDate: "2026-09-30",
      craftIds: [buttoning!.craftId, cutting!.craftId],
      orderQuantity: 80,
    }, "order-craft-create-key");

    expect(created.value).toMatchObject({
      processes: ["钉扣", "裁片定位"],
      crafts: [
        {
          position: 1,
          craftId: buttoning!.craftId,
          craftName: "钉扣",
          craftVersion: 1,
        },
        {
          position: 2,
          craftId: cutting!.craftId,
          craftName: "裁片定位",
          craftVersion: 1,
        },
      ],
    });

    await service.reviseCraft(actor("disable-bound-craft"), buttoning!.craftId, {
      craftName: "钉扣（暂停）",
      active: false,
      changeReason: "暂不允许新订单选择",
    });

    expect((await database.query(
      `SELECT position,craft_id,craft_version,craft_name_snapshot
       FROM sourcing_case_crafts
       WHERE sourcing_case_id=$1
       ORDER BY position`,
      [created.value.sourcingCaseId],
    )).rows).toEqual([
      {
        position: 1,
        craft_id: buttoning!.craftId,
        craft_version: 1,
        craft_name_snapshot: "钉扣",
      },
      {
        position: 2,
        craft_id: cutting!.craftId,
        craft_version: 1,
        craft_name_snapshot: "裁片定位",
      },
    ]);
    expect((await database.query(
      "SELECT process_items FROM sourcing_cases WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rows[0]).toEqual({ process_items: ["钉扣", "裁片定位"] });

    await expect(sourcingService.createCase(sourcingActor("inactive-order"), {
      erpOrderNo: "ERP-CRAFT-002",
      styleNo: "CRAFT-002",
      deliveryDate: "2026-10-01",
      craftIds: [buttoning!.craftId],
      orderQuantity: 20,
    }, "inactive-order-key")).rejects.toThrow("所选工艺已停用或不存在");
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
