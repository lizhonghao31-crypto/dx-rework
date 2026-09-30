import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
import { completeInspectionReport } from "../inspection-report-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("process configuration and IE review PostgreSQL contracts", () => {
  const schema = "process_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: "-c search_path=" + schema,
  });
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const ids = {
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    merchandiser: randomUUID(),
  };
  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    requestId: randomUUID(),
  });
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tail = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0006_rework_initiation.sql",
      "0056_n01_digital_inspection_report.sql",
      "0007_process_configuration_ie_review.sql",
    ]) {
      const sql = await readFile(
        new URL("../../apps/api/migrations/" + migration, import.meta.url),
        "utf8",
      );
      await database.query(sql);
    }
    for (const [userId, displayName] of [
      [ids.qc, "品控一"],
      [ids.tail, "李同生"],
      [ids.ie, "郎飞"],
      [ids.merchandiser, "订单跟单"],
    ] as const) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,$2)", [userId, displayName]);
      await database.query(
        "INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)",
        [randomUUID(), userId, "ding-" + userId, "union-" + userId],
      );
    }
    await database.query(
      "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'quality_control',$2,'controlled bootstrap'),($3,$4,'tail_supervisor',$4,'controlled bootstrap'),($5,$6,'ie_reviewer',$6,'controlled bootstrap'),($7,$8,'order_merchandiser',$8,'controlled bootstrap')",
      [
        randomUUID(), ids.qc,
        randomUUID(), ids.tail,
        randomUUID(), ids.ie,
        randomUUID(), ids.merchandiser,
      ],
    );
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','corp')",
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  const submittedOrder = async () => {
    const draft = await initiation.createDraft(qc(), {
      styleNo: "PD20611308",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "特殊返修",
      reworkQuantity: 281,
      inspectionReport: completeInspectionReport(),
    }, randomUUID());
    return initiation.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());
  };

  it("keeps configured items immutable, truncates price and promotes custom processes only after IE approval", async () => {
    const submitted = await submittedOrder();
    const draft = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.version,
      items: [{
        source: "custom",
        customProcessName: "特殊翻边返修",
        pricingUnit: "piece",
        plannedQuantity: 281,
        unitPrice: 1.005,
      }],
    }, randomUUID());
    expect(draft.value.configuration?.items[0]?.unitPrice).toBe(1.005);
    const draftAgain = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: draft.value.orderVersion,
      items: [{
        source: "custom",
        customProcessName: "特殊翻边返修",
        pricingUnit: "piece",
        plannedQuantity: 281,
        unitPrice: 1.005,
      }],
    }, "stable-process-draft");
    const replay = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: draft.value.orderVersion,
      items: [{
        source: "custom",
        customProcessName: "特殊翻边返修",
        pricingUnit: "piece",
        plannedQuantity: 281,
        unitPrice: 1.005,
      }],
    }, "stable-process-draft");
    expect(replay.reused).toBe(true);
    expect(replay.value.configuration?.configurationId).toBe(draftAgain.value.configuration?.configurationId);

    const queued = await configuration.submit(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: draftAgain.value.orderVersion,
      expectedConfigurationVersion: draftAgain.value.configuration!.configurationVersion,
    }, randomUUID());
    expect(queued.value.reworkStatus).toBe("pending_ie_review");

    const approved = await configuration.review(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: queued.value.orderVersion,
      expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    expect(approved.value.reworkStatus).toBe("pending_task_assignment");
    expect(approved.value.configuration?.status).toBe("approved");
    expect(approved.value.configuration?.items[0]?.promotedProcessId).not.toBeNull();
    expect((await database.query(
      "SELECT 1 FROM current_process_catalog WHERE process_name='特殊翻边返修' AND active=true",
    )).rowCount).toBe(1);
    await expect(database.query(
      "UPDATE rework_process_configuration_items SET unit_price=9.999 WHERE configuration_id=$1",
      [approved.value.configuration!.configurationId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("uses a new change version and returns a rejected change to the task-assignment node", async () => {
    const submitted = await submittedOrder();
    const first = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.version,
      items: [{
        source: "custom",
        customProcessName: "压线返修",
        pricingUnit: "hour",
        plannedQuantity: 1.15,
        unitPrice: 8.1269,
      }],
    }, randomUUID());
    const queued = await configuration.submit(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: first.value.orderVersion,
      expectedConfigurationVersion: first.value.configuration!.configurationVersion,
    }, randomUUID());
    const approved = await configuration.review(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: queued.value.orderVersion,
      expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    expect(approved.value.configuration?.items[0]?.plannedQuantity).toBe(1.15);

    const change = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: approved.value.orderVersion,
      changeReason: "现场复核后增加工时",
      items: [{
        source: "custom",
        customProcessName: "压线返修",
        pricingUnit: "hour",
        plannedQuantity: 2.239,
        unitPrice: 8.1269,
      }],
    }, randomUUID());
    expect(change.value.configuration?.kind).toBe("change");
    expect(change.value.configuration?.items[0]?.plannedQuantity).toBe(2.23);
    expect(change.value.configuration?.items[0]?.unitPrice).toBe(8.126);

    const changeQueued = await configuration.submit(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: change.value.orderVersion,
      expectedConfigurationVersion: change.value.configuration!.configurationVersion,
    }, randomUUID());
    const rejected = await configuration.review(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: changeQueued.value.orderVersion,
      expectedConfigurationVersion: changeQueued.value.configuration!.configurationVersion,
      decision: "rejected",
      reason: "变更依据不足",
    }, randomUUID());
    expect(rejected.value.reworkStatus).toBe("pending_task_assignment");
    expect(rejected.value.configuration?.status).toBe("rejected");
    expect((await database.query(
      "SELECT count(*)::int count FROM rework_process_configurations WHERE rework_order_id=$1 AND status='approved'",
      [submitted.value.reworkOrderId],
    )).rows[0]?.count).toBe(1);
  });

  it("serializes simultaneous same-name custom promotions into one public process", async () => {
    const [firstOrder, secondOrder] = await Promise.all([submittedOrder(), submittedOrder()]);
    const [firstDraft, secondDraft] = await Promise.all([
      configuration.saveDraft(tail(), firstOrder.value.reworkOrderId, {
        expectedOrderVersion: firstOrder.value.version,
        items: [{
          source: "custom",
          customProcessName: "并发共享工序",
          pricingUnit: "piece",
          plannedQuantity: 10,
          unitPrice: 1.005,
        }],
      }, randomUUID()),
      configuration.saveDraft(tail(), secondOrder.value.reworkOrderId, {
        expectedOrderVersion: secondOrder.value.version,
        items: [{
          source: "custom",
          customProcessName: "并发共享工序",
          pricingUnit: "piece",
          plannedQuantity: 10,
          unitPrice: 1.005,
        }],
      }, randomUUID()),
    ]);
    const [firstQueued, secondQueued] = await Promise.all([
      configuration.submit(tail(), firstOrder.value.reworkOrderId, {
        expectedOrderVersion: firstDraft.value.orderVersion,
        expectedConfigurationVersion: firstDraft.value.configuration!.configurationVersion,
      }, randomUUID()),
      configuration.submit(tail(), secondOrder.value.reworkOrderId, {
        expectedOrderVersion: secondDraft.value.orderVersion,
        expectedConfigurationVersion: secondDraft.value.configuration!.configurationVersion,
      }, randomUUID()),
    ]);

    const blocker = await database.connect();
    let transactionOpen = false;
    try {
      await blocker.query("BEGIN");
      transactionOpen = true;
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('dx_rework:custom-process:' || lower($1) || ':' || $2))",
        ["并发共享工序", "piece"],
      );
      let completed = false;
      const reviews = Promise.all([
        configuration.review(ie(), firstOrder.value.reworkOrderId, {
          expectedOrderVersion: firstQueued.value.orderVersion,
          expectedConfigurationVersion: firstQueued.value.configuration!.configurationVersion,
          decision: "approved",
        }, randomUUID()),
        configuration.review(ie(), secondOrder.value.reworkOrderId, {
          expectedOrderVersion: secondQueued.value.orderVersion,
          expectedConfigurationVersion: secondQueued.value.configuration!.configurationVersion,
          decision: "approved",
        }, randomUUID()),
      ]).then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(completed).toBe(false);
      await blocker.query("COMMIT");
      transactionOpen = false;

      const approved = await reviews;
      expect(approved.map((result) => result.value.reworkStatus)).toEqual([
        "pending_task_assignment",
        "pending_task_assignment",
      ]);
      expect((await database.query(
        "SELECT 1 FROM current_process_catalog WHERE lower(process_name)=lower($1) AND pricing_unit=$2 AND active=true",
        ["并发共享工序", "piece"],
      )).rowCount).toBe(1);
    } finally {
      if (transactionOpen) await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  it("separates IE review from both the order initiator and the configuration creator", async () => {
    const firstOrder = await submittedOrder();
    const firstDraft = await configuration.saveDraft(tail(), firstOrder.value.reworkOrderId, {
      expectedOrderVersion: firstOrder.value.version,
      items: [{
        source: "custom",
        customProcessName: "审核岗位分离一",
        pricingUnit: "piece",
        plannedQuantity: 1,
        unitPrice: 1,
      }],
    }, randomUUID());
    const firstQueued = await configuration.submit(tail(), firstOrder.value.reworkOrderId, {
      expectedOrderVersion: firstDraft.value.orderVersion,
      expectedConfigurationVersion: firstDraft.value.configuration!.configurationVersion,
    }, randomUUID());
    await expect(configuration.review(
      actor(ids.qc, ["quality_control", "tail_supervisor", "ie_reviewer"], "process:review"),
      firstOrder.value.reworkOrderId,
      {
        expectedOrderVersion: firstQueued.value.orderVersion,
        expectedConfigurationVersion: firstQueued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const secondOrder = await submittedOrder();
    const secondDraft = await configuration.saveDraft(tail(), secondOrder.value.reworkOrderId, {
      expectedOrderVersion: secondOrder.value.version,
      items: [{
        source: "custom",
        customProcessName: "审核岗位分离二",
        pricingUnit: "piece",
        plannedQuantity: 1,
        unitPrice: 1,
      }],
    }, randomUUID());
    const secondQueued = await configuration.submit(tail(), secondOrder.value.reworkOrderId, {
      expectedOrderVersion: secondDraft.value.orderVersion,
      expectedConfigurationVersion: secondDraft.value.configuration!.configurationVersion,
    }, randomUUID());
    await expect(configuration.review(
      actor(ids.tail, ["tail_supervisor", "ie_reviewer"], "process:review"),
      secondOrder.value.reworkOrderId,
      {
        expectedOrderVersion: secondQueued.value.orderVersion,
        expectedConfigurationVersion: secondQueued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("completes opposite multi-process promotions without duplicate catalog items", async () => {
    const queueForReview = async (reverse: boolean) => {
      const submitted = await submittedOrder();
      const items = [
        {
          source: "custom" as const,
          customProcessName: "锁顺序甲",
          pricingUnit: "piece" as const,
          plannedQuantity: 1,
          unitPrice: 1,
        },
        {
          source: "custom" as const,
          customProcessName: "锁顺序乙",
          pricingUnit: "piece" as const,
          plannedQuantity: 1,
          unitPrice: 1,
        },
      ];
      if (reverse) items.reverse();
      const draft = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
        expectedOrderVersion: submitted.value.version,
        items,
      }, randomUUID());
      return {
        orderId: submitted.value.reworkOrderId,
        orderVersion: draft.value.orderVersion,
        configurationVersion: draft.value.configuration!.configurationVersion,
      };
    };

    const [firstDraft, secondDraft] = await Promise.all([queueForReview(false), queueForReview(true)]);
    const [firstQueued, secondQueued] = await Promise.all([
      configuration.submit(tail(), firstDraft.orderId, {
        expectedOrderVersion: firstDraft.orderVersion,
        expectedConfigurationVersion: firstDraft.configurationVersion,
      }, randomUUID()),
      configuration.submit(tail(), secondDraft.orderId, {
        expectedOrderVersion: secondDraft.orderVersion,
        expectedConfigurationVersion: secondDraft.configurationVersion,
      }, randomUUID()),
    ]);
    const reviewed = await Promise.all([
      configuration.review(ie(), firstDraft.orderId, {
        expectedOrderVersion: firstQueued.value.orderVersion,
        expectedConfigurationVersion: firstQueued.value.configuration!.configurationVersion,
        decision: "approved",
      }, randomUUID()),
      configuration.review(ie(), secondDraft.orderId, {
        expectedOrderVersion: secondQueued.value.orderVersion,
        expectedConfigurationVersion: secondQueued.value.configuration!.configurationVersion,
        decision: "approved",
      }, randomUUID()),
    ]);
    expect(reviewed.map((result) => result.value.reworkStatus)).toEqual([
      "pending_task_assignment",
      "pending_task_assignment",
    ]);
    const catalog = await database.query<{ process_name: string }>(
      "SELECT process_name FROM current_process_catalog WHERE process_name=ANY($1::text[]) AND active=true",
      [["锁顺序甲", "锁顺序乙"]],
    );
    expect(catalog.rows.map((row) => row.process_name).sort()).toEqual(["锁顺序甲", "锁顺序乙"].sort());
  });

});
