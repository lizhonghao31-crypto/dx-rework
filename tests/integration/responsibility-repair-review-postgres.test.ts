import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationQueueService } from "../../apps/api/src/rework/responsibility-determination-queue-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql",
  "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql",
  "0010_responsibility_determination_amount_engine.sql",
  "0011_responsibility_authorization_handler_closure.sql",
  "0012_responsibility_direct_delegation.sql",
  "0013_responsibility_review_closure.sql",
  "0014_responsibility_source_share_coverage.sql",
] as const;

runWithPostgres("responsibility repair-review closure", () => {
  const schema = "responsibility_repair_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: "-c search_path=" + schema,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const queue = new ResponsibilityDeterminationQueueService(database);

  const ids = {
    admin: randomUUID(),
    production: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    merch: randomUUID(),
    workerOne: randomUUID(),
    workerTwo: randomUUID(),
  };
  const business = {
    orderId: "",
    itemId: "",
  };

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    ...authorizationCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability: authorizationCapabilities[0]!,
    authorizationCapabilities,
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of migrations) {
      await database.query(
        await readFile(
          new URL("../../apps/api/migrations/" + migration, import.meta.url),
          "utf8",
        ),
      );
    }

    for (const [userId, displayName, role] of [
      [ids.admin, "Admin", "system_admin"],
      [ids.production, "Production", "production_management"],
      [ids.qc, "QC", "quality_control"],
      [ids.tail, "Tail", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.merch, "Merch", "order_merchandiser"],
      [ids.workerOne, "Worker One", "worker"],
      [ids.workerTwo, "Worker Two", "worker"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name) VALUES($1,$2)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, "ding-" + userId, "union-" + userId],
      );
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$2,'fixture')`,
        [randomUUID(), userId, role],
      );
    }

    await access.ensureOrganizationPolicy();
    const workerOne = (
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.workerOne,
          displayName: "Worker One",
          aliases: [],
          reason: "repair review fixture",
        },
      )
    ).personId;
    const workerTwo = (
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.workerTwo,
          displayName: "Worker Two",
          aliases: [],
          reason: "repair review fixture",
        },
      )
    ).personId;

    const created = await initiation.createDraft(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      {
        styleNo: "REPAIR-QUEUE",
        merchandiserUserId: ids.merch,
        processingFactory: { type: "own_factory" },
        problemPart: "袖口",
        problemDescription: "repair review",
        reworkQuantity: 1,
      },
      randomUUID(),
    );
    const submitted = await initiation.submit(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      created.value.reworkOrderId,
      { expectedVersion: created.value.version },
      randomUUID(),
    );
    const saved = await configuration.saveDraft(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: submitted.value.version,
        items: [
          {
            source: "custom",
            customProcessName: "repair process",
            pricingUnit: "piece",
            plannedQuantity: 1,
            unitPrice: 1,
          },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion:
          saved.value.configuration!.configurationVersion,
      },
      randomUUID(),
    );
    const approved = await configuration.review(
      actor(ids.ie, ["ie_reviewer"], "process:review"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion:
          queued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    const itemId = approved.value.configuration!.items[0]!.configurationItemId;
    const task = await reporting.createTask(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId: itemId,
        mode: "collective",
        members: [{ personId: workerOne }, { personId: workerTwo }],
      },
      randomUUID(),
    );
    const listed = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.workerOne, ["worker"], "work:report"),
      task.value.workTaskId,
      {
        expectedOrderVersion: listed.orderVersion,
        actualQuantity: 1,
        completedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    const reviewView = await review.get(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
    );
    await review.approve(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
      { expectedOrderVersion: reviewView.orderVersion, temporaryCoefficients: [] },
      randomUUID(),
    );

    business.orderId = created.value.reworkOrderId;
    business.itemId = itemId;
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  it("lists real UUID orders only for database-authorized responsibility users", async () => {
    const productionQueue = await queue.list(
      actor(
        ids.production,
        ["production_management"],
        "responsibility:determine",
      ),
    );
    expect(productionQueue.items).toEqual([
      expect.objectContaining({
        reworkOrderId: business.orderId,
        styleNo: "REPAIR-QUEUE",
        handlerUserId: null,
        canDetermine: true,
      }),
    ]);

    const forgedAdminQueue = await queue.list(
      actor(
        ids.admin,
        ["system_admin"],
        "responsibility:determine",
        "responsibility:takeover",
      ),
    );
    expect(forgedAdminQueue.items).toEqual([]);
  });

  it("rejects a trusted version that omits one reviewed member share", async () => {
    const source = await database.query<{
      order_review_id: string;
      process_name: string;
      pricing_unit: "piece" | "hour";
      work_report_id: string;
      person_id: string;
      amount: string;
      display_name_snapshot: string;
      assignment_mode: "individual" | "collective";
    }>(
      `SELECT review.order_review_id,
              item.process_name,
              item.pricing_unit,
              report.work_report_id,
              share.person_id,
              share.amount::text,
              member.display_name_snapshot,
              task.assignment_mode
       FROM rework_order_reviews review
       JOIN rework_process_configurations configuration
         ON configuration.rework_order_id=review.rework_order_id
        AND configuration.status='approved'
       JOIN rework_process_configuration_items item
         ON item.configuration_id=configuration.configuration_id
       JOIN rework_work_reports report
         ON report.rework_order_id=review.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
        AND report.status='submitted'
       JOIN rework_work_report_member_shares share
         ON share.work_report_id=report.work_report_id
       JOIN rework_work_tasks task
         ON task.work_task_id=report.work_task_id
       JOIN rework_work_task_members member
         ON member.work_task_id=task.work_task_id
        AND member.person_id=share.person_id
       LEFT JOIN rework_work_report_rejections rejection
         ON rejection.work_report_id=report.work_report_id
       WHERE review.rework_order_id=$1
         AND rejection.work_report_id IS NULL
       ORDER BY share.person_id`,
      [business.orderId],
    );
    expect(source.rows).toHaveLength(2);
    const included = source.rows[0]!;
    expect(included.amount).toBe("0.50000000");

    const client = await database.connect();
    const eventId = randomUUID();
    const requestId = "repair-review-omitted-share";
    const determinationId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,before_state,after_state,reason
         ) VALUES(
           $1,$2,$3,ARRAY['production_management'],'responsibility:determine',
           'rework.responsibility.draft','rework_order',$4,'{}','{}',
           'omit one reviewed source share'
         )`,
        [eventId, requestId, ids.production, business.orderId],
      );
      await client.query(
        `SELECT set_config('dx_rework.responsibility_event_id',$1,true),
                set_config('dx_rework.responsibility_request_id',$2,true)`,
        [eventId, requestId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_determinations(
           determination_id,rework_order_id,determination_version,
           replaces_determination_id,source_order_review_id,stage,
           handler_user_id,created_by,reason,
           source_high_multiplier_confirmation_id,input_snapshot,
           calculation_total,operation_event_id,request_id
         ) VALUES(
           $1,$2,1,NULL,$3,'draft',$4,$4,NULL,NULL,'{}',0.50,$5,$6
         )`,
        [
          determinationId,
          business.orderId,
          included.order_review_id,
          ids.production,
          eventId,
          requestId,
        ],
      );
      await client.query(
        `INSERT INTO rework_responsibility_processes(
           determination_id,configuration_item_id,process_name_snapshot,
           pricing_unit_snapshot,multiplier,high_multiplier_reason,
           base_amount,responsibility_amount,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,1.000,NULL,0.50000000,0.50,$5,$6)`,
        [
          determinationId,
          business.itemId,
          included.process_name,
          included.pricing_unit,
          eventId,
          requestId,
        ],
      );
      await client.query(
        `INSERT INTO rework_responsibility_allocations(
           determination_id,configuration_item_id,responsibility_type,
           share_bps,rounded_amount,operation_event_id,request_id
         ) VALUES($1,$2,'own_factory',10000,0.50,$3,$4)`,
        [determinationId, business.itemId, eventId, requestId],
      );
      await client.query(
        `INSERT INTO rework_responsibility_amount_lines(
           determination_id,configuration_item_id,work_report_id,person_id,
           responsibility_type,base_member_share_amount,multiplier,share_bps,
           unrounded_amount,rounded_amount,rounding_rule,
           worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
           report_snapshot,operation_event_id,request_id
         ) VALUES(
           $1,$2,$3,$4,'own_factory',$5,1.000,10000,
           0.500000000000000,0.50,'half_up_2',$6,$7,$8,$9,$10,$11
         )`,
        [
          determinationId,
          business.itemId,
          included.work_report_id,
          included.person_id,
          included.amount,
          included.display_name_snapshot,
          included.assignment_mode,
          { personId: included.person_id, amount: included.amount },
          { workReportId: included.work_report_id },
          eventId,
          requestId,
        ],
      );

      await expect(
        client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      ).rejects.toThrow(/exactly cover reviewed source shares/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
