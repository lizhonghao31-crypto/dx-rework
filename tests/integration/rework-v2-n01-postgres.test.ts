import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkSupplyContextService } from "../../apps/api/src/rework/supply-context-service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("rework v2 N01 PostgreSQL contracts", () => {
  const schema = ownedPostgresSchema("rework_v2");
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const todoService = new TodoService(database);
  const todoProjection = new TodoProjectionService(todoService);
  const initiation = new ReworkInitiationService(
    database,
    "corp",
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const supplyContext = new ReworkSupplyContextService(database, "corp");
  const v2Submission = new ReworkV2SubmissionService(
    database,
    "corp",
    undefined,
    undefined,
    undefined,
    todoProjection,
  );

  const ids = {
    owner: randomUUID(),
    root: randomUUID(),
    qc: randomUUID(),
    merchandiser: randomUUID(),
    embroideryMerchandiser: randomUUID(),
    tail: randomUUID(),
  };
  let factorySupplierId = "";
  let washingSupplierId = "";
  let embroiderySupplierId = "";
  let fabricSupplierId = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...authorizationCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: Array.from(new Set([
      authorizationCapability,
      ...authorizationCapabilities,
    ])),
    requestId: randomUUID(),
  });
  const ownerMaster = () => actor(ids.owner, ["owner_group"], "master_data:manage");
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const root = () => actor(
    ids.root,
    ["root_superuser", "quality_control"],
    "rework:initiate",
    "business:read_all",
  );

  const readyImage = async (uploadedBy: string): Promise<string> => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'n01-v2.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, "f".repeat(64), uploadedBy],
    );
    return attachmentId;
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
      await database.query(
        "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
        [migration.version, migration.checksum],
      );
    }

    const roleUsers = [
      [ids.owner, "老板", "owner_group"],
      [ids.qc, "质检", "quality_control"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
      [ids.embroideryMerchandiser, "印绣花跟单", "embroidery_washing_merchandiser"],
      [ids.tail, "尾部主管", "tail_supervisor"],
    ] as const;
    for (const [userId, displayName, roleCode] of roleUsers) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
      );
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$2,'n01-v2 fixture')`,
        [randomUUID(), userId, roleCode],
      );
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Root',true)",
      [ids.root],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,
         active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), ids.root, `ding-${ids.root}`, `union-${ids.root}`],
    );
    await access.ensureOrganizationPolicy();

    factorySupplierId = (await access.createSupplier(ownerMaster(), {
      supplierCode: "V2FAC01",
      supplierType: "factory",
      supplierName: "V2加工厂",
      active: true,
      changeReason: "N01 v2 test factory",
    })).supplierId;
    washingSupplierId = (await access.createSupplier(ownerMaster(), {
      supplierCode: "V2WASH01",
      supplierType: "embroidery_washing",
      supplierName: "V2洗水厂",
      active: true,
      changeReason: "N01 v2 washing supplier",
    })).supplierId;
    embroiderySupplierId = (await access.createSupplier(ownerMaster(), {
      supplierCode: "V2EMB01",
      supplierType: "embroidery_washing",
      supplierName: "V2印绣花厂",
      active: true,
      changeReason: "N01 v2 embroidery supplier",
    })).supplierId;
    fabricSupplierId = (await access.createSupplier(ownerMaster(), {
      supplierCode: "V2FAB01",
      supplierType: "fabric",
      supplierName: "V2面辅料供应商",
      active: true,
      changeReason: "N01 v2 fabric supplier",
    })).supplierId;
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("submits N01 with only style, processing factory, order merchandiser and image while preserving optional supply context", async () => {
    const attachmentId = await readyImage(ids.qc);
    const draft = await initiation.createDraft(qc(), {
      styleNo: "V2-N01-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      attachmentIds: [attachmentId],
    }, randomUUID());
    expect(draft.value).toMatchObject({
      status: "draft",
      styleNo: "V2-N01-001",
      orderQuantity: null,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
    });

    const savedContext = await supplyContext.save(qc(), draft.value.reworkOrderId, {
      washingSupplierId,
      embroiderySupplierId,
      fabricSupplierId,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
    });
    expect(savedContext).toMatchObject({
      reworkOrderId: draft.value.reworkOrderId,
      washingSupplier: { supplierId: washingSupplierId },
      embroiderySupplier: { supplierId: embroiderySupplierId },
      fabricSupplier: { supplierId: fabricSupplierId },
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
      version: 1,
    });

    const submitted = await v2Submission.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      styleNo: "V2-N01-001",
      merchandiserUserId: ids.merchandiser,
      orderQuantity: null,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
      reworkNo: expect.stringMatching(/^RW-/),
    });

    const orderRow = (await database.query(
      `SELECT order_quantity,problem_part,problem_description,rework_quantity,inspection_report
       FROM rework_orders WHERE rework_order_id=$1`,
      [draft.value.reworkOrderId],
    )).rows[0];
    expect(orderRow).toEqual({
      order_quantity: null,
      problem_part: null,
      problem_description: null,
      rework_quantity: null,
      inspection_report: null,
    });
    expect((await database.query(
      `SELECT action,entity_type,authorization_capability
       FROM operation_events
       WHERE entity_id=$1
       ORDER BY created_at`,
      [draft.value.reworkOrderId],
    )).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rework.supply_context.save",
        entity_type: "rework_order_supply_context",
        authorization_capability: "rework:initiate",
      }),
      expect.objectContaining({
        action: "rework.submit",
        entity_type: "rework_order",
        authorization_capability: "rework:initiate",
      }),
    ]));
  });

  it("rejects a v2 submission without a ready bound image", async () => {
    const draft = await initiation.createDraft(qc(), {
      styleNo: "V2-N01-NO-IMAGE",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
    }, randomUUID());
    await expect(v2Submission.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "REWORK_IMAGE_REQUIRED",
      statusCode: 400,
    });
    expect((await initiation.getOwn(qc(), draft.value.reworkOrderId)).status).toBe("draft");
  });

  it("lets Root take over a QC draft, change optional context and submit without owning the existing image", async () => {
    const attachmentId = await readyImage(ids.qc);
    const draft = await initiation.createDraft(qc(), {
      styleNo: "V2-N01-ROOT",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      attachmentIds: [attachmentId],
    }, randomUUID());

    const rootContext = await supplyContext.save(root(), draft.value.reworkOrderId, {
      washingSupplierId,
      embroiderySupplierId: null,
      fabricSupplierId,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
    });
    expect(rootContext).toMatchObject({
      washingSupplier: { supplierId: washingSupplierId },
      fabricSupplier: { supplierId: fabricSupplierId },
    });

    const submitted = await v2Submission.submit(
      root(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      styleNo: "V2-N01-ROOT",
      attachmentIds: [attachmentId],
    });
    expect((await database.query(
      `SELECT actor_id,actor_roles
       FROM operation_events
       WHERE action='rework.submit' AND entity_id=$1`,
      [draft.value.reworkOrderId],
    )).rows[0]).toMatchObject({
      actor_id: ids.root,
      actor_roles: expect.arrayContaining(["root_superuser", "quality_control"]),
    });
  });

  it("keeps tail finishing separate from QC initiation and submits without a report", async () => {
    const supervisor = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
    const receivingBatchId = randomUUID();
    await database.query(
      "INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity) VALUES($1,'V2-FINISHING-001',$2,100)",
      [receivingBatchId, ids.tail],
    );
    const payload = {
      receivingBatchId,
      styleNo: "V2-FINISHING-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier" as const, supplierId: factorySupplierId },
      tailInspectionRequired: false,
    };
    await expect(initiation.createDraft(qc(), payload, randomUUID(), "inhouse_finishing"))
      .rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(initiation.createDraft(supervisor(), { ...payload, receivingBatchId: undefined }, randomUUID(), "inhouse_finishing"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    await expect(initiation.createDraft(supervisor(), { ...payload, tailInspectionRequired: true }, randomUUID(), "inhouse_finishing"))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    const key = randomUUID();
    const draft = await initiation.createDraft(supervisor(), payload, key, "inhouse_finishing");
    expect(draft.value).toMatchObject({ status: "draft", reworkKind: "inhouse_finishing", attachmentIds: [] });
    expect((await initiation.createDraft(supervisor(), payload, key, "inhouse_finishing")).reused).toBe(true);
    await expect(initiation.createDraft(supervisor(), payload, randomUUID(), "inhouse_finishing"))
      .rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(await initiation.getFinishingDraft(supervisor(), draft.value.reworkOrderId))
      .toMatchObject({ reworkOrderId: draft.value.reworkOrderId, status: "draft" });
    await expect(v2Submission.submit(supervisor(), draft.value.reworkOrderId,
      { expectedVersion: draft.value.version }, randomUUID()))
      .rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const submitted = await v2Submission.submit(supervisor(), draft.value.reworkOrderId,
      { expectedVersion: draft.value.version }, randomUUID(), "inhouse_finishing");
    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration", reworkKind: "inhouse_finishing", attachmentIds: [],
    });
    expect((await database.query(
      "SELECT action,authorization_capability FROM operation_events WHERE entity_id=$1 AND action LIKE 'rework.finishing.%' ORDER BY created_at",
      [draft.value.reworkOrderId],
    )).rows).toEqual([
      { action: "rework.finishing.draft.create", authorization_capability: "process:configure" },
      { action: "rework.finishing.submit", authorization_capability: "process:configure" },
    ]);
  });
});
