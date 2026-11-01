import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductionOrderRootRepository } from "../../apps/api/src/production-platform/order-root-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;

run("digital production order root boundaries", () => {
  const schema = ownedPostgresSchema("full_chain");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const creator = randomUUID();

  beforeAll(async () => {
    await createOwnedPostgresSchema(admin, schema);
    for (const name of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0216_digital_production_order_roots.sql",
    ]) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'digital production fixture',true)",
      [creator],
    );
  });

  afterAll(async () => {
    await database.end();
    await releaseOwnedPostgresSchema(admin, schema);
    await admin.end();
  });

  it("starts empty so legacy orders are never silently migrated", async () => {
    const result = await database.query("SELECT count(*)::integer AS count FROM production_order_roots");
    expect(result.rows[0].count).toBe(0);
  });

  it("creates only explicit digital-production roots with an immutable generation", async () => {
    const repository = new ProductionOrderRootRepository(database);
    const root = await repository.create(creator);
    expect(root.workflowGeneration).toBe("digital_production_v1");
    expect((await repository.read(root.productionOrderId))?.createdBy).toBe(creator);

    await expect(
      database.query(
        "UPDATE production_order_roots SET workflow_generation='legacy' WHERE production_order_id=$1",
        [root.productionOrderId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      database.query("DELETE FROM production_order_roots WHERE production_order_id=$1", [root.productionOrderId]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects an invented legacy generation instead of using a timestamp cutover", async () => {
    await expect(
      database.query(
        "INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by) VALUES($1,'legacy',$2)",
        [randomUUID(), creator],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
