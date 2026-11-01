import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionOrderRootRepository } from "../../apps/api/src/production-platform/order-root-repository.js";
import { ProductionOrderNodeClockRepository } from "../../apps/api/src/production-platform/node-clock-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("digital production node clock boundaries", () => {
  const schema = ownedPostgresSchema("full_chain");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const creator = randomUUID();
  let productionOrderId = "";

  beforeAll(async () => {
    await createOwnedPostgresSchema(admin, schema);
    for (const name of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0216_digital_production_order_roots.sql",
      "0217_digital_production_node_clocks.sql",
    ]) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'node clock fixture',true)",
      [creator],
    );
    productionOrderId = (await new ProductionOrderRootRepository(database).create(creator)).productionOrderId;
  });

  afterAll(async () => {
    await database.end();
    await releaseOwnedPostgresSchema(admin, schema);
    await admin.end();
  });

  it("creates a clock only for an explicit new digital-production root", async () => {
    const clocks = new ProductionOrderNodeClockRepository(database);
    await expect(clocks.enter({
      productionOrderId: randomUUID(),
      nodeKey: "pattern",
      occurrence: 1,
      enteredAt: new Date("2026-09-28T08:00:00.000Z"),
      warningAt: new Date("2026-09-29T00:00:00.000Z"),
      dueAt: new Date("2026-09-29T08:00:00.000Z"),
      deadlinePolicyKey: "pattern_v1",
      deadlinePolicyVersion: 1,
      createdBy: creator,
    })).rejects.toMatchObject({ code: "23503" });
  });

  it("freezes entered/warning/due facts and allows completion exactly once", async () => {
    const clocks = new ProductionOrderNodeClockRepository(database);
    const node = await clocks.enter({
      productionOrderId,
      nodeKey: "pattern",
      occurrence: 1,
      enteredAt: new Date("2026-09-28T08:00:00.000Z"),
      warningAt: new Date("2026-09-29T00:00:00.000Z"),
      dueAt: new Date("2026-09-29T08:00:00.000Z"),
      deadlinePolicyKey: "pattern_v1",
      deadlinePolicyVersion: 1,
      createdBy: creator,
    });

    await expect(database.query(
      "UPDATE production_order_node_clocks SET due_at=due_at + interval '1 hour' WHERE node_instance_id=$1",
      [node.nodeInstanceId],
    )).rejects.toMatchObject({ code: "55000" });

    const completed = await clocks.complete(node.nodeInstanceId, new Date("2026-09-29T07:00:00.000Z"));
    expect(completed.completedAt?.toISOString()).toBe("2026-09-29T07:00:00.000Z");

    await expect(
      clocks.complete(node.nodeInstanceId, new Date("2026-09-29T07:30:00.000Z")),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      database.query("DELETE FROM production_order_node_clocks WHERE node_instance_id=$1", [node.nodeInstanceId]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("supports a later occurrence without resetting the original occurrence", async () => {
    const clocks = new ProductionOrderNodeClockRepository(database);
    const second = await clocks.enter({
      productionOrderId,
      nodeKey: "pattern",
      occurrence: 2,
      enteredAt: new Date("2026-09-30T08:00:00.000Z"),
      warningAt: new Date("2026-10-01T00:00:00.000Z"),
      dueAt: new Date("2026-10-01T08:00:00.000Z"),
      deadlinePolicyKey: "pattern_v1",
      deadlinePolicyVersion: 1,
      createdBy: creator,
    });
    expect(second.occurrence).toBe(2);
    expect((await clocks.listForOrder(productionOrderId)).map(item => item.occurrence)).toEqual([1, 2]);
  });

  it("rejects clocks whose warning/deadline chronology is invalid", async () => {
    const clocks = new ProductionOrderNodeClockRepository(database);
    await expect(clocks.enter({
      productionOrderId,
      nodeKey: "cutting",
      occurrence: 1,
      enteredAt: new Date("2026-09-28T08:00:00.000Z"),
      warningAt: new Date("2026-09-30T08:00:00.000Z"),
      dueAt: new Date("2026-09-29T08:00:00.000Z"),
      deadlinePolicyKey: "cutting_v1",
      deadlinePolicyVersion: 1,
      createdBy: creator,
    })).rejects.toMatchObject({ code: "23514" });
  });
});
