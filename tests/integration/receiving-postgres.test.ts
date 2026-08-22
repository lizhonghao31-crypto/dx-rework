import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

const businessDate = (): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

runWithPostgres("receiving fact PostgreSQL contracts", () => {
  const schema = `receiving_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const service = new ReceivingService(database);
  const receiverId = randomUUID();

  const receiver = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["warehouse_receiver"],
    authorizationCapability: "receiving:create",
    authorizationCapabilities: ["receiving:create"],
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0006_rework_initiation.sql",
      "0076_receiving_fact_layer.sql",
    ]) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'仓管测试',true)",
      [receiverId],
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("keeps each receipt immutable while cumulative same-style differences can return to zero", async () => {
    const firstKey = randomUUID();
    const first = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
    }, firstKey);
    expect(first.reused).toBe(false);
    expect(first.value).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      differenceQuantity: -20,
      receivedBy: receiverId,
    });

    const replay = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
    }, firstKey);
    expect(replay.reused).toBe(true);

    const shortageBoard = await service.board(businessDate());
    expect(shortageBoard.rows[0]).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      differenceQuantity: -20,
      receiptCount: 1,
      lastReceiverName: "仓管测试",
    });
    expect(shortageBoard.kpis.abnormalOrderCount).toBe(1);

    const second = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 120,
    }, randomUUID());
    expect(second.value.differenceQuantity).toBe(20);

    const balancedBoard = await service.board(businessDate());
    expect(balancedBoard.rows).toHaveLength(1);
    expect(balancedBoard.rows[0]).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 200,
      actualQuantity: 200,
      differenceQuantity: 0,
      receiptCount: 2,
    });
    expect(balancedBoard.kpis.orderCount).toBe(1);
    expect(balancedBoard.kpis.receivedQuantity).toBe(200);
    expect(balancedBoard.kpis.abnormalOrderCount).toBe(0);
    expect(balancedBoard.kpis.differenceQuantity).toBe(0);
    expect(balancedBoard.kpis.differenceRate).toBe(0);

    const facts = await database.query<{ difference_quantity: number }>(
      "SELECT difference_quantity FROM receiving_receipts WHERE style_no=$1 ORDER BY received_at,receipt_id",
      ["STYLE-RECEIVING-01"],
    );
    expect(facts.rows.map((row) => row.difference_quantity).sort((a, b) => a - b)).toEqual([-20, 20]);

    await expect(database.query(
      "UPDATE receiving_receipts SET actual_quantity=100 WHERE receipt_id=$1",
      [first.value.receiptId],
    )).rejects.toThrow();
  });

  it("searches known style numbers without forcing a second manual spelling", async () => {
    const options = await service.listStyleOptions("RECEIVING");
    expect(options).toContain("STYLE-RECEIVING-01");
  });
});
